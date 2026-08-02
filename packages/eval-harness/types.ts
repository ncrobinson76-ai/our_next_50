// The core weekly-synthesis data model (BaselineProfile, Observation,
// EvidencePacket, SynthesisOutput, etc.) moved to packages/synthesis-core in
// Package 9, shared with packages/api. Re-exported here so every existing
// file in this package can keep importing from "./types" unchanged.
//
// ScenarioInput itself stays local: it's the shape of scenarios/*.json,
// specific to how this eval harness feeds fictional test data in — real
// data (packages/api) is assembled into an EvidencePacket a completely
// different way and has no use for this type.
export * from "../synthesis-core/types";

import {
  BaselineProfile,
  MedicationContext,
  Observation,
  PriorExperiment,
  WeeklyReflection,
} from "../synthesis-core/types";

/** Raw per-scenario input, as stored in scenarios/*.json. */
export interface ScenarioInput {
  id: string;
  baseline: BaselineProfile;
  observations: Observation[];
  weeklyReflection: WeeklyReflection;
  priorExperiment?: PriorExperiment | null;
  medicationContext?: MedicationContext | null;
}
