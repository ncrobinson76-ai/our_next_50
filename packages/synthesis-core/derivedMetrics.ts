// Pure computations over an Observation[] array, extracted from
// packages/eval-harness's original buildEvidencePacket() in Package 9 so
// both eval-harness (fictional scenarios) and packages/api (real DB data)
// can compute the same DerivedMetrics from whatever Observation[] each one
// assembles in its own domain-specific way.

import { DerivedMetrics, Observation, WeightMeasurement } from "./types";

export function daysBetweenInclusive(startDate: string, endDate: string): number {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const diffMs = end.getTime() - start.getTime();
  return Math.max(1, Math.round(diffMs / (1000 * 60 * 60 * 24)) + 1);
}

export function computeWeightTrend(observations: Observation[]): DerivedMetrics["weightTrend"] {
  const weighed = observations
    .filter((obs): obs is Observation & { weight: WeightMeasurement } => Boolean(obs.weight))
    .sort((a, b) => a.date.localeCompare(b.date));

  if (weighed.length < 1) return undefined;

  const firstLogged = weighed[0].weight;
  const lastLogged = weighed[weighed.length - 1].weight;

  return {
    firstLogged,
    lastLogged,
    deltaValue: Number((lastLogged.value - firstLogged.value).toFixed(2)),
    unit: lastLogged.unit,
  };
}

export function computeAverageSleepHours(observations: Observation[]): number | undefined {
  const withSleep = observations.filter((obs) => typeof obs.sleep?.hours === "number");
  if (withSleep.length === 0) return undefined;
  const total = withSleep.reduce((sum, obs) => sum + (obs.sleep!.hours ?? 0), 0);
  return Number((total / withSleep.length).toFixed(2));
}

export function computeAverageHungerLevel(observations: Observation[]): number | undefined {
  const levels = observations.flatMap((obs) => obs.hunger?.map((h) => h.level) ?? []);
  if (levels.length === 0) return undefined;
  const total = levels.reduce((sum, level) => sum + level, 0);
  return Number((total / levels.length).toFixed(2));
}
