import type { ScopedDataAccess } from "../data/scopedDataAccess";
import { asWeightUnit, isTrusted, type ObservationRow } from "../weeklyReview/evidencePacket";
import { computeWeightTrend, type DerivedMetrics, type Observation as DayObservation } from "../synthesisCore";
import type { ExperimentStatus } from "../experiment/service";

// Package 11 Part A: a factual rollup of data that already exists
// (Observations, ProgramWeeks, Experiments) — deliberately NOT the
// synthesis engine's job. No LLM call, no new interpretation, nothing
// written. The weight-trend logic specifically reuses evidencePacket.ts's
// isTrusted() and synthesis-core's computeWeightTrend() rather than
// re-deriving a parallel "which observations count" rule — see this
// file's imports.

export interface WeightTrendPoint {
  date: string;
  value: number;
  unit: "lb" | "kg";
}

export interface ProgramWeekSummary {
  totalElapsed: number;
  evidenceSufficientCount: number;
  /** Honest per PRD Section 8.7 — a Progress view that hid this would be
   * exactly the "track less, learn more" ethos violation PRD Section 5
   * warns against. */
  skippedCount: number;
}

const EXPERIMENT_STATUSES: ExperimentStatus[] = ["proposed", "accepted", "modified", "declined", "paused", "retired"];

export interface ActiveExperimentSummary {
  id: string;
  recommendation: string;
  status: ExperimentStatus;
  startedAt: Date | null;
}

export interface ExperimentSummary {
  countsByStatus: Record<ExperimentStatus, number>;
  active: ActiveExperimentSummary[];
}

export interface NonScaleWinEntry {
  date: string;
  description: string;
}

export interface ProgressSummary {
  weightTrend: {
    series: WeightTrendPoint[];
    trend: DerivedMetrics["weightTrend"];
  };
  programWeeks: ProgramWeekSummary;
  experiments: ExperimentSummary;
  nonScaleWins: {
    count: number;
    entries: NonScaleWinEntry[];
  };
}

/** One point per calendar day — the latest trusted entry wins if a day somehow has more than one, same rule as evidencePacket.ts's per-day weight field. */
function buildWeightSeries(observations: ObservationRow[]): WeightTrendPoint[] {
  const trustedWeights = observations.filter(
    (o) => o.type === "weight" && isTrusted(o) && !o.isExplicitNonEvent && o.value !== null
  );

  const latestPerDay = new Map<string, ObservationRow>();
  for (const row of trustedWeights) {
    const existing = latestPerDay.get(row.observedDate);
    if (!existing || row.createdAt.getTime() > existing.createdAt.getTime()) {
      latestPerDay.set(row.observedDate, row);
    }
  }

  return [...latestPerDay.values()]
    .sort((a, b) => a.observedDate.localeCompare(b.observedDate))
    .map((row) => ({ date: row.observedDate, value: Number(row.value), unit: asWeightUnit(row.unit) }));
}

/** Reuses synthesis-core's computeWeightTrend() (the exact function evidencePacket.ts calls per-week) instead of re-deriving first-vs-last logic for the full program. */
function computeFullProgramTrend(series: WeightTrendPoint[]): DerivedMetrics["weightTrend"] {
  const dayObservations: DayObservation[] = series.map((point) => ({
    date: point.date,
    weight: { value: point.value, unit: point.unit, date: point.date },
  }));
  return computeWeightTrend(dayObservations);
}

async function buildProgramWeekSummary(data: ScopedDataAccess): Promise<ProgramWeekSummary> {
  // Deliberately does NOT call syncProgramWeeksThroughToday — this is a
  // read-only view (Part A's own constraint: "no new write logic"), same
  // "GET never has side effects" rule GET /api/program-weeks already
  // established in Package 10.
  const weeks = await data.programWeeks.list();
  return {
    totalElapsed: weeks.length,
    evidenceSufficientCount: weeks.filter((w) => w.evidenceSufficient).length,
    skippedCount: weeks.filter((w) => w.status === "skipped").length,
  };
}

async function buildExperimentSummary(data: ScopedDataAccess): Promise<ExperimentSummary> {
  const all = await data.experiments.list();

  const countsByStatus = Object.fromEntries(EXPERIMENT_STATUSES.map((status) => [status, 0])) as Record<
    ExperimentStatus,
    number
  >;
  for (const experiment of all) countsByStatus[experiment.status]++;

  const active = all
    .filter((e) => e.status === "accepted" || e.status === "modified")
    .map((e) => ({ id: e.id, recommendation: e.recommendation, status: e.status, startedAt: e.startedAt }));

  return { countsByStatus, active };
}

function buildNonScaleWins(observations: ObservationRow[]): { count: number; entries: NonScaleWinEntry[] } {
  const entries = observations
    .filter((o) => o.type === "non_scale_win" && isTrusted(o) && !o.isExplicitNonEvent)
    .sort((a, b) => a.observedDate.localeCompare(b.observedDate))
    .map((o) => ({ date: o.observedDate, description: o.textValue ?? "(no description)" }));
  return { count: entries.length, entries };
}

export async function buildProgressSummary(data: ScopedDataAccess): Promise<ProgressSummary> {
  const allObservations = await data.observations.list();
  // Superseded rows are corrected-away — excluded here for the same
  // reason evidencePacket.ts excludes them from a weekly packet.
  const current = allObservations.filter((o) => !o.isSuperseded);

  const series = buildWeightSeries(current);

  const [programWeeks, experiments] = await Promise.all([
    buildProgramWeekSummary(data),
    buildExperimentSummary(data),
  ]);

  return {
    weightTrend: { series, trend: computeFullProgramTrend(series) },
    programWeeks,
    experiments,
    nonScaleWins: buildNonScaleWins(current),
  };
}
