// Shared data model for the weekly-synthesis pipeline.
// These types are intentionally broader than what this eval script strictly
// needs, since they're expected to be reused as the real Observation /
// EvidencePacket data model in Package 1.

export type WeightUnit = "lb" | "kg";
export type HeightUnit = "in" | "cm";

export interface WeightMeasurement {
  value: number;
  unit: WeightUnit;
  /** ISO date (YYYY-MM-DD) or date-time the measurement was taken. */
  date: string;
  timeOfDay?: "morning" | "afternoon" | "evening" | "unspecified";
}

export interface BaselineProfile {
  userId: string;
  /** ISO date the user's program/tracking began. */
  startDate: string;
  startingWeight: WeightMeasurement;
  height?: {
    value: number;
    unit: HeightUnit;
  };
  age?: number;
  sex?: string;
  goal: {
    type: "weight-loss" | "weight-gain" | "maintenance" | "body-composition" | "other";
    description: string;
    targetWeight?: {
      value: number;
      unit: WeightUnit;
    };
  };
  activityBaseline?: string;
  dietaryPattern?: string;
  /** Free-text context that doesn't fit a structured field yet. */
  notes?: string;
}

export interface MedicationEntry {
  name: string;
  class?: string;
  startDate?: string;
  dosage?: string;
  notes?: string;
}

export interface MedicationContext {
  medications: MedicationEntry[];
}

export interface MealEntry {
  time?: string;
  description: string;
  approxCalories?: number;
}

export interface ActivityEntry {
  type: string;
  durationMinutes?: number;
  intensity?: "low" | "moderate" | "high";
  notes?: string;
}

export interface HungerEntry {
  /** 1 (no hunger) to 10 (extreme hunger). */
  level: number;
  context?: string;
}

/** A single day's worth of logged data. Any field may be absent if unlogged. */
export interface Observation {
  date: string;
  weight?: WeightMeasurement;
  sleep?: {
    hours: number;
    quality?: "poor" | "fair" | "good";
  };
  meals?: MealEntry[];
  hunger?: HungerEntry[];
  activity?: ActivityEntry[];
  symptoms?: string[];
  freeTextNotes?: string;
}

export interface PriorExperiment {
  description: string;
  hypothesis?: string;
  startDate: string;
  status: "ongoing" | "completed" | "abandoned";
  outcomeNotes?: string;
}

export interface WeeklyReflection {
  weekStartDate: string;
  weekEndDate: string;
  reflectionText: string;
  selfReportedAdherence?: "high" | "medium" | "low";
  selfReportedMood?: string;
  moodTags?: string[];
}

/** Raw per-scenario input, as stored in scenarios/*.json. */
export interface ScenarioInput {
  id: string;
  baseline: BaselineProfile;
  observations: Observation[];
  weeklyReflection: WeeklyReflection;
  priorExperiment?: PriorExperiment | null;
  medicationContext?: MedicationContext | null;
}

/**
 * Derived, computed facts about the week (e.g. trends, averages) that are
 * calculated from raw observations rather than asserted by the model.
 */
export interface DerivedMetrics {
  loggedDayCount: number;
  totalDayCount: number;
  weightTrend?: {
    firstLogged: WeightMeasurement;
    lastLogged: WeightMeasurement;
    deltaValue: number;
    unit: WeightUnit;
  };
  averageSleepHours?: number;
  averageHungerLevel?: number;
  [key: string]: unknown;
}

/**
 * The assembled, evidence-only bundle handed to the synthesis model.
 * Everything the model is allowed to reference must trace back to this.
 */
export interface EvidencePacket {
  scenarioId: string;
  baseline: BaselineProfile;
  observations: Observation[];
  weeklyReflection: WeeklyReflection;
  priorExperiment?: PriorExperiment | null;
  medicationContext?: MedicationContext | null;
  derivedMetrics: DerivedMetrics;
}

export type SafetyCategory =
  | "urgent-symptom"
  | "crisis-language"
  | "disordered-eating"
  | "rapid-weight-change";

export interface SafetyCheckResult {
  flagged: boolean;
  categories: SafetyCategory[];
  reasons: string[];
  /** Fixed, non-LLM message to show when flagged=true. */
  pathwayMessage?: string;
}

export interface ProposedNextStep {
  type: "experiment" | "no-change" | "insufficient-evidence";
  description: string;
}

export interface SynthesisOutput {
  scenarioId: string;
  safetyCheck: SafetyCheckResult;
  /** True when the safety pathway short-circuited normal synthesis. */
  safetyPathwayTriggered: boolean;
  recordedFacts: string[];
  observationsSummary: string[];
  tentativeHypotheses: string[];
  whatsWorking: string[];
  friction: string[];
  whatShouldRemainUnchanged: string[];
  proposedNextStep: ProposedNextStep;
  /** Raw model text, kept for debugging/audit; absent on safety short-circuit. */
  rawModelResponse?: string;
}
