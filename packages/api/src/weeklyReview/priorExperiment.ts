import type { ScopedDataAccess } from "../data/scopedDataAccess";
import type { PriorExperiment } from "../synthesisCore";
import type { ExperimentRow, ExperimentStatus } from "../experiment/service";
import type { ObservationRow } from "./evidencePacket";

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Only these four statuses represent an experiment the user actually
// engaged with (accepted or edited-and-accepted it, whether still going,
// paused, or wrapped up) — "proposed" (never acted on) and "declined"
// convey nothing useful as prior-week context for a new synthesis.
const ENGAGED_STATUSES: ExperimentStatus[] = ["accepted", "modified", "paused", "retired"];

/**
 * The most recent Experiment the user engaged with, started strictly
 * before the given ProgramWeek's start date. Returns null if there is
 * none — a week with no prior experiment must still correctly omit the
 * packet's priorExperiment field, not fabricate one.
 */
export async function findMostRecentEngagedExperiment(
  data: ScopedDataAccess,
  beforeWeekStartDate: string
): Promise<ExperimentRow | null> {
  const all = await data.experiments.list();
  const engaged = all.filter(
    (e) => ENGAGED_STATUSES.includes(e.status) && e.startedAt !== null && toISODate(e.startedAt) < beforeWeekStartDate
  );
  if (engaged.length === 0) return null;

  engaged.sort((a, b) => b.startedAt!.getTime() - a.startedAt!.getTime());
  return engaged[0];
}

// packages/synthesis-core's PriorExperiment.status is the coarser 3-value
// set ("ongoing" | "completed" | "abandoned") Package 0 designed against
// fictional scenarios — a deliberate simplification versus the DB's
// 6-value experimentStatusEnum, not a 1:1 mirror. Mapping:
//   accepted, modified -> "ongoing"   (still actively being followed)
//   paused             -> "abandoned" (not currently being followed,
//                                      whether or not the user resumes it)
//   retired            -> "completed" (the experiment concluded)
// The raw DB status word is preserved in outcomeNotes below so nothing is
// actually lost to this coarser bucketing, even though the structured
// `status` field itself can't carry more than three values.
const STATUS_MAP: Record<ExperimentStatus, PriorExperiment["status"]> = {
  proposed: "ongoing",
  declined: "abandoned",
  accepted: "ongoing",
  modified: "ongoing",
  paused: "abandoned",
  retired: "completed",
};

function summarizeCompletions(completions: ObservationRow[]): string {
  if (completions.length === 0) {
    return "No completion check-ins were logged for this experiment.";
  }
  const done = completions.filter((o) => !o.isExplicitNonEvent).length;
  const notDone = completions.length - done;
  return `Logged as done on ${done} and not done on ${notDone} of ${completions.length} tracked check-in(s).`;
}

/** Maps a DB Experiment row + its completion check-ins into synthesis-core's PriorExperiment shape. */
export async function buildPriorExperienceContext(
  data: ScopedDataAccess,
  experiment: ExperimentRow
): Promise<PriorExperiment> {
  const completionObservationIds = await data.experimentCompletionObservations.listObservationIds(experiment.id);
  const allObservations = await data.observations.list();
  const completions = allObservations.filter((o) => completionObservationIds.includes(o.id));

  const outcomeParts = [summarizeCompletions(completions)];
  if (experiment.outcome) outcomeParts.push(experiment.outcome);
  outcomeParts.push(`(Raw status: ${experiment.status}.)`);

  return {
    description: experiment.recommendation,
    hypothesis: experiment.rationale,
    startDate: experiment.startedAt ? toISODate(experiment.startedAt) : toISODate(experiment.createdAt),
    status: STATUS_MAP[experiment.status],
    outcomeNotes: outcomeParts.join(" "),
  };
}
