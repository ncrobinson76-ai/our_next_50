import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import type { experiments as experimentsTable, observations as observationsTable } from "../db";
import type { ScopedDataAccess } from "../data/scopedDataAccess";
import type { SynthesisOutput } from "../synthesisCore";

export type ExperimentRow = InferSelectModel<typeof experimentsTable>;
type ExperimentInsert = Omit<InferInsertModel<typeof experimentsTable>, "userId">;
export type ExperimentStatus = ExperimentRow["status"];
type ObservationInsert = Omit<InferInsertModel<typeof observationsTable>, "userId">;

// Package 10: creating an Experiment from a WeeklyReview's proposedNextStep,
// and the accept/modify/decline/pause/retire/log-completion lifecycle on
// top of it.
//
// Mapping note, worth being explicit about: this package's spec says to
// pull recommendation/rationale/target/difficulty/unchangedBehaviors
// "directly from the synthesis output's own fields... reuse it, don't
// reinterpret it." In practice, packages/synthesis-core/types.ts's
// SynthesisOutput (the Package 0 shape, unmodified since) has no dedicated
// "target" or "difficulty" field, and no field literally named "rationale"
// — only `proposedNextStep.description`, `tentativeHypotheses`, and
// `whatShouldRemainUnchanged`. Rather than invent values for target/
// difficulty (which the shared, rubric-validated prompt was never asked to
// produce) or quietly extend that prompt/type to add them, this maps what
// genuinely exists: `recommendation` <- proposedNextStep.description,
// `unchangedBehaviors` <- whatShouldRemainUnchanged (an exact field-name
// correspondence), `rationale` <- tentativeHypotheses joined into prose
// (the closest existing "why" content). `target` and `difficulty` are left
// null — an honest gap, not a fabricated value — until/unless a future
// package deliberately extends the prompt to propose them.

/** Only called when synthesis.proposedNextStep.type === "experiment"; returns null otherwise. */
export async function createExperimentFromSynthesis(
  data: ScopedDataAccess,
  weeklyReviewId: string,
  synthesis: SynthesisOutput
): Promise<ExperimentRow | null> {
  if (synthesis.proposedNextStep.type !== "experiment") return null;

  const rationale =
    synthesis.tentativeHypotheses.length > 0
      ? synthesis.tentativeHypotheses.join(" ")
      : "No specific hypothesis was recorded for this experiment; see the associated WeeklyReview for full context.";

  const insertValues: ExperimentInsert = {
    weeklyReviewId,
    recommendation: synthesis.proposedNextStep.description,
    rationale,
    unchangedBehaviors: synthesis.whatShouldRemainUnchanged,
    target: null,
    difficulty: null,
    status: "proposed",
  };
  return data.experiments.create(insertValues);
}

// Legal status transitions. "modified" is reached only from "proposed"
// (the user's alternative to accepting as-is), and — once accepted or
// modified — an experiment is "actively engaged with" for the purposes of
// pause/retire/log-completion; both statuses are treated identically from
// there on. declined/retired are terminal.
const VALID_TRANSITIONS: Record<ExperimentStatus, ExperimentStatus[]> = {
  proposed: ["accepted", "modified", "declined"],
  accepted: ["paused", "retired"],
  modified: ["paused", "retired"],
  paused: ["retired"],
  declined: [],
  retired: [],
};

/** "accepted" or "modified" — both represent an experiment the user is actively engaged with. */
export function isActivelyAccepted(status: ExperimentStatus): boolean {
  return status === "accepted" || status === "modified";
}

export type TransitionResult =
  | { ok: true; experiment: ExperimentRow }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "illegal_transition"; from: ExperimentStatus; to: ExperimentStatus };

async function transition(
  data: ScopedDataAccess,
  id: string,
  to: ExperimentStatus,
  patch: Partial<ExperimentInsert> = {}
): Promise<TransitionResult> {
  const existing = await data.experiments.findById(id);
  if (!existing) return { ok: false, reason: "not_found" };

  if (!VALID_TRANSITIONS[existing.status].includes(to)) {
    return { ok: false, reason: "illegal_transition", from: existing.status, to };
  }

  const updated = await data.experiments.update(id, { status: to, ...patch });
  return { ok: true, experiment: updated! };
}

export async function acceptExperiment(data: ScopedDataAccess, id: string): Promise<TransitionResult> {
  return transition(data, id, "accepted", { startedAt: new Date() });
}

export interface ModifyResult {
  ok: true;
  experiment: ExperimentRow;
}
export type ModifyOutcome =
  | ModifyResult
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "illegal_transition"; from: ExperimentStatus; to: "modified" };

/**
 * Accepts a user-edited version of the recommendation. The `experiments`
 * table has no dedicated "original vs. edited" column, so the edit is
 * stored by overwriting `recommendation` and appending an audit note to
 * `rationale` recording what the original text was — reusing an existing
 * free-text field rather than adding a schema column for this alone.
 */
export async function modifyExperiment(
  data: ScopedDataAccess,
  id: string,
  newRecommendation: string
): Promise<ModifyOutcome> {
  const existing = await data.experiments.findById(id);
  if (!existing) return { ok: false, reason: "not_found" };

  if (!VALID_TRANSITIONS[existing.status].includes("modified")) {
    return { ok: false, reason: "illegal_transition", from: existing.status, to: "modified" };
  }

  const auditedRationale = `${existing.rationale}\n\n[User modified the original recommendation from: "${existing.recommendation}"]`;
  const updated = await data.experiments.update(id, {
    status: "modified",
    recommendation: newRecommendation,
    rationale: auditedRationale,
    startedAt: existing.startedAt ?? new Date(),
  });
  return { ok: true, experiment: updated! };
}

export async function declineExperiment(data: ScopedDataAccess, id: string): Promise<TransitionResult> {
  return transition(data, id, "declined");
}

export async function pauseExperiment(data: ScopedDataAccess, id: string): Promise<TransitionResult> {
  return transition(data, id, "paused");
}

export async function retireExperiment(data: ScopedDataAccess, id: string, outcome?: string): Promise<TransitionResult> {
  return transition(data, id, "retired", outcome !== undefined ? { outcome } : {});
}

export interface LogCompletionInput {
  completed: boolean;
  date: string;
  note?: string;
}

export type LogCompletionResult =
  | { ok: true; observationId: string }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_active"; status: ExperimentStatus };

/**
 * A lightweight completion check-in, separate from full Observation
 * logging (no extraction/LLM call) — writes one Observation of type
 * "experiment_completion" directly and links it via the
 * experimentCompletionObservations junction. isExplicitNonEvent encodes
 * "did not do it" (the boolean's negative), matching PRD Section 8.4's
 * existing explicit-non-event concept rather than inventing a new field.
 */
export async function logCompletion(
  data: ScopedDataAccess,
  experimentId: string,
  input: LogCompletionInput
): Promise<LogCompletionResult> {
  const experiment = await data.experiments.findById(experimentId);
  if (!experiment) return { ok: false, reason: "not_found" };
  if (!isActivelyAccepted(experiment.status)) {
    return { ok: false, reason: "not_active", status: experiment.status };
  }

  // Assigned to a locally-typed const rather than an inline literal — see
  // weeklyReview/service.ts's WeeklyReviewInsert comment for why TypeScript's
  // excess-property check needs this against Omit<InferInsertModel<...>, "userId">.
  const insertValues: ObservationInsert = {
    type: "experiment_completion",
    observedDate: input.date,
    textValue: input.note ?? null,
    isExplicitNonEvent: !input.completed,
    confidenceLevel: "user_reported",
    verificationState: "confirmed",
  };
  const observation = await data.observations.create(insertValues);
  await data.experimentCompletionObservations.createLink(experimentId, observation.id);

  return { ok: true, observationId: observation.id };
}
