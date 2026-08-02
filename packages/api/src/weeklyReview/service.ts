import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import type { weeklyReviews as weeklyReviewsTable } from "../db";
import type { ScopedDataAccess } from "../data/scopedDataAccess";
import type { SafetyPolicyCategory } from "../inbox/safetyScreen";
import { runSafetyCheck, synthesizeFromPacket, type SynthesisOutput } from "../synthesisCore";
import { createExperimentFromSynthesis } from "../experiment/service";
import { assembleEvidencePacket } from "./evidencePacket";
import { buildPriorExperienceContext, findMostRecentEngagedExperiment } from "./priorExperiment";
import {
  computeLoggedDayCount,
  findProgramStartDate,
  isEvidenceSufficient,
  syncProgramWeeksThroughToday,
} from "./programWeek";

type WeeklyReviewRow = InferSelectModel<typeof weeklyReviewsTable>;
type WeeklyReviewInsert = Omit<InferInsertModel<typeof weeklyReviewsTable>, "userId">;

// Bumped only if packages/synthesis-core's SYSTEM_PROMPT itself changes —
// deliberately NOT "package-9", since Package 9 reuses Package 0's prompt
// unmodified. This value should track the prompt's own provenance, not
// which package last touched the plumbing around it.
const SYNTHESIS_PROMPT_VERSION = "package-0-synthesis-engine-v1";

// Distinct from packages/api/src/inbox/pipeline.ts's SAFETY_SCREEN_VERSION
// (the per-entry screen) — this is the weekly-level, whole-packet gate
// added in Package 9.
export const WEEKLY_SAFETY_GATE_VERSION = "package-9-weekly-safety-gate-v1";

export type GenerateReviewResult =
  | { status: "no_profile" }
  | { status: "safety_flagged"; pathwayMessage?: string }
  | { status: "generated"; review: WeeklyReviewRow };

function toSafetyPolicyCategory(category: string): SafetyPolicyCategory {
  // eval-harness's SafetyCategory uses hyphens ("urgent-symptom"); the DB
  // enum uses underscores ("urgent_symptom"). All 4 categories the shared
  // safety check can produce map 1:1 onto the DB's (larger) enum this way.
  return category.replace(/-/g, "_") as SafetyPolicyCategory;
}

function renderReport(synthesis: SynthesisOutput): string {
  const lines: string[] = [];
  const section = (title: string, items: string[]) => {
    lines.push(`## ${title}`, "");
    if (items.length === 0) {
      lines.push("_None._", "");
    } else {
      for (const item of items) lines.push(`- ${item}`);
      lines.push("");
    }
  };

  section("What we recorded", synthesis.recordedFacts);
  section("Patterns this week", synthesis.observationsSummary);
  section("Possible explanations", synthesis.tentativeHypotheses);
  section("What's working", synthesis.whatsWorking);
  section("Friction", synthesis.friction);
  section("Keep doing this", synthesis.whatShouldRemainUnchanged);
  lines.push(`## Suggested next step (${synthesis.proposedNextStep.type})`, "");
  lines.push(synthesis.proposedNextStep.description, "");

  return lines.join("\n");
}

/**
 * The full flow: sync real sequential ProgramWeeks through today (Package
 * 10 — backfilling any missed weeks honestly along the way), find the most
 * recent Experiment the user actually engaged with for priorExperiment
 * context, assemble a real EvidencePacket from this user's own data, run
 * the weekly-level safety gate, and — only if it doesn't flag — call the
 * shared synthesis engine, persist a WeeklyReview, and (if the synthesis
 * proposed one) create a new Experiment from it.
 */
export async function generateCurrentWeekReview(data: ScopedDataAccess): Promise<GenerateReviewResult> {
  const profileVersions = await data.participantProfiles.list();
  if (profileVersions.length === 0) {
    return { status: "no_profile" };
  }
  const programStartDate = findProgramStartDate(profileVersions);
  if (!programStartDate) {
    return { status: "no_profile" };
  }
  const currentProfile = profileVersions.reduce((max, p) => (p.version > max.version ? p : max));

  const { current: programWeek } = await syncProgramWeeksThroughToday(data, programStartDate);

  const priorExperimentRow = await findMostRecentEngagedExperiment(data, programWeek.weekStartDate);
  const priorExperience = priorExperimentRow ? await buildPriorExperienceContext(data, priorExperimentRow) : null;

  const allObservations = await data.observations.list();
  const { packet, includedObservationIds } = assembleEvidencePacket(
    programWeek,
    currentProfile,
    programStartDate,
    allObservations,
    priorExperience
  );

  // Weekly-level safety gate, BEFORE any call to the synthesis LLM. A
  // genuinely different, additional check from the per-entry
  // safetyScreen.ts (Package 5/8): per-entry catches things as they're
  // logged one at a time; this evaluates a whole week's aggregated
  // evidence at once, so it can catch patterns (e.g. a week-over-week
  // weight swing, or a gradual multi-entry crisis pattern) that no single
  // entry's screening would have triggered.
  const safetyCheck = runSafetyCheck(packet);
  if (safetyCheck.flagged) {
    for (const category of safetyCheck.categories) {
      const mapped = toSafetyPolicyCategory(category);
      // No single Observation or InboxEvent caused this flag — it's a
      // property of the whole week's aggregated packet — so, unlike the
      // per-entry screen, there's no single sourceObservationId/
      // sourceInboxEventId to attach.
      const insertValues = {
        policyCategory: mapped,
        pathwayKey: mapped,
        systemVersion: WEEKLY_SAFETY_GATE_VERSION,
      };
      await data.safetyEvents.create(insertValues);
    }
    return { status: "safety_flagged", pathwayMessage: safetyCheck.pathwayMessage };
  }

  const synthesis = await synthesizeFromPacket(packet);
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

  // Assigned to a locally-typed const rather than passed as an inline
  // literal — matching packages/api/src/routes/participantProfiles.ts's
  // toDbInsert() convention — because TypeScript's excess-property check
  // against Omit<InferInsertModel<...>, "userId"> resolves unreliably for
  // a fresh literal argument on this particular table (jsonb + enum
  // columns), even though the shape is valid.
  const insertValues: WeeklyReviewInsert = {
    programWeekId: programWeek.id,
    participantProfileVersionId: currentProfile.id,
    aiModel: model,
    promptVersion: SYNTHESIS_PROMPT_VERSION,
    structuredClaims: {
      recordedFacts: synthesis.recordedFacts,
      observationsSummary: synthesis.observationsSummary,
      tentativeHypotheses: synthesis.tentativeHypotheses,
      whatsWorking: synthesis.whatsWorking,
      friction: synthesis.friction,
      whatShouldRemainUnchanged: synthesis.whatShouldRemainUnchanged,
      proposedNextStep: synthesis.proposedNextStep,
    },
    renderedReport: renderReport(synthesis),
    status: "generated",
  };
  const review = await data.weeklyReviews.create(insertValues);

  await data.weeklyReviewInputObservations.createMany(review.id, includedObservationIds);

  // Refine the ProgramWeek's evidenceSufficient flag using the packet's
  // own authoritative loggedDayCount (computed from the exact same
  // filtered weekRows used for synthesis, more precise than the quick
  // pre-check syncProgramWeeksThroughToday ran before any packet existed),
  // and mark the week completed now that a review has actually been
  // generated for it.
  await data.programWeeks.update(programWeek.id, {
    status: "completed",
    evidenceSufficient: isEvidenceSufficient(computeLoggedDayCount(allObservations, programWeek.weekStartDate, programWeek.weekEndDate)),
  });

  await createExperimentFromSynthesis(data, review.id, synthesis);

  return { status: "generated", review };
}
