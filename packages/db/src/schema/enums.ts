import { pgEnum } from "drizzle-orm/pg-core";

// Shared value types, aligned with packages/eval-harness/types.ts where the
// concepts overlap (WeightUnit, HeightUnit, timeOfDay), so vocabulary stays
// consistent as this becomes the real data model.

export const weightUnitEnum = pgEnum("weight_unit", ["lb", "kg"]);
export const lengthUnitEnum = pgEnum("length_unit", ["in", "cm"]);
export const timeOfDayEnum = pgEnum("time_of_day", [
  "morning",
  "afternoon",
  "evening",
  "unspecified",
]);

// InboxEvent.channel — extensible: future channels (e.g. new messaging
// providers) are added with an ALTER TYPE ... ADD VALUE migration, which
// drizzle-kit generates fine (no hand-written SQL needed).
export const inboxChannelEnum = pgEnum("inbox_channel", ["voice", "text", "form"]);
export const inboxStatusEnum = pgEnum("inbox_status", [
  "received",
  "processing",
  "processed",
  "failed",
  // Package 5's extraction pipeline (PRD Section 9/10): a per-entry safety
  // screen ran first and flagged this event — no extraction happens, ever.
  "safety_flagged",
  // Extraction proposed exactly one follow-up question (INB-06) and is
  // waiting on the user's answer before finalizing.
  "needs_followup",
]);

export const retentionStateEnum = pgEnum("retention_state", [
  "active",
  "pending_deletion",
  "deleted",
]);

// Observation.type — the 11 types from the PRD Section 12 conceptual model.
export const observationTypeEnum = pgEnum("observation_type", [
  "weight",
  "waist",
  "sleep",
  "meal",
  "hunger",
  "energy",
  "activity",
  "experiment_completion",
  "context_reflection",
  "symptom_safety",
  "non_scale_win",
]);

export const confidenceLevelEnum = pgEnum("confidence_level", [
  "measured",
  "user_reported",
  "approximate",
]);

export const verificationStateEnum = pgEnum("verification_state", [
  "proposed",
  "confirmed",
  "corrected",
]);

export const safetyPolicyCategoryEnum = pgEnum("safety_policy_category", [
  "urgent_symptom",
  "crisis_language",
  "disordered_eating",
  "rapid_weight_change",
  "other",
]);

export const safetyResolutionStatusEnum = pgEnum("safety_resolution_status", [
  "open",
  "acknowledged",
  "resolved",
]);

export const programWeekStatusEnum = pgEnum("program_week_status", [
  "scheduled",
  "in_progress",
  "completed",
  "skipped",
]);

export const weeklyReviewStatusEnum = pgEnum("weekly_review_status", [
  "draft",
  "generated",
  "delivered",
  "acknowledged",
]);

// Experiment.status — exact set given in the PRD.
export const experimentStatusEnum = pgEnum("experiment_status", [
  "proposed",
  "accepted",
  "modified",
  "declined",
  "paused",
  "retired",
]);

export const experimentDifficultyEnum = pgEnum("experiment_difficulty", [
  "easy",
  "moderate",
  "hard",
]);
