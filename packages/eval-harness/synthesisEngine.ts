// Scenario-specific EvidencePacket assembly for this eval harness's
// fictional fixtures. The engine itself (system prompt, LLM call, safety
// check) moved to packages/synthesis-core in Package 9 — see
// synthesizeFromPacket() there for what's now shared with packages/api,
// which assembles its EvidencePackets from real DB data instead of a
// ScenarioInput.

import { synthesizeFromPacket } from "../synthesis-core/synthesisEngine";
import {
  computeAverageHungerLevel,
  computeAverageSleepHours,
  computeWeightTrend,
  daysBetweenInclusive,
} from "../synthesis-core/derivedMetrics";
import { DerivedMetrics, EvidencePacket, ScenarioInput, SynthesisOutput } from "./types";

export function buildEvidencePacket(scenario: ScenarioInput): EvidencePacket {
  const { weeklyReflection, observations } = scenario;

  const derivedMetrics: DerivedMetrics = {
    loggedDayCount: observations.length,
    totalDayCount: daysBetweenInclusive(
      weeklyReflection.weekStartDate,
      weeklyReflection.weekEndDate
    ),
    weightTrend: computeWeightTrend(observations),
    averageSleepHours: computeAverageSleepHours(observations),
    averageHungerLevel: computeAverageHungerLevel(observations),
  };

  return {
    scenarioId: scenario.id,
    baseline: scenario.baseline,
    observations: scenario.observations,
    weeklyReflection: scenario.weeklyReflection,
    priorExperiment: scenario.priorExperiment ?? null,
    medicationContext: scenario.medicationContext ?? null,
    derivedMetrics,
  };
}

/** Convenience wrapper matching this package's original signature: build the packet from a scenario, then synthesize. */
export async function synthesizeWeek(scenario: ScenarioInput): Promise<SynthesisOutput> {
  const packet = buildEvidencePacket(scenario);
  return synthesizeFromPacket(packet);
}
