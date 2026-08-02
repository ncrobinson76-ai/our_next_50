// PRD Section 8.2 baseline onboarding fields — this list is exhaustive by
// design. Every field below carries a one-line justification for why it's
// collected at all; packages/db's participantProfiles table happens to
// have exactly these columns (no unused extras to worry about leaving
// alone). Do not add a field here without a comment naming which of
// review logic / safety logic / unit handling / experiment selection it
// serves — if you can't write that honestly, don't add it.

export type WeightUnit = "lb" | "kg";
export type LengthUnit = "in" | "cm";

export interface ProfileGoalInput {
  type: "weight-loss" | "weight-gain" | "maintenance" | "body-composition" | "other";
  description: string;
  targetWeight?: { value: number; unit: WeightUnit };
}

export interface ParticipantProfileInput {
  // age range or DOB: review logic — age-appropriate framing and pacing
  // expectations in the weekly synthesis. At least one of the two is
  // required (enforced in validation.ts, not at the DB level).
  dateOfBirth?: string;
  ageRange?: string;

  // height: review logic — body-frame context for interpreting weight
  // trends (a given change reads differently at different frame sizes).
  // Optional.
  height?: { value: number; unit: LengthUnit };

  // starting weight: review logic — the baseline every subsequent weight
  // observation and trend is measured against; unit handling — fixes the
  // user's preferred measurement unit. Required.
  startingWeight: { value: number; unit: WeightUnit; date: string };

  // waist: review logic — optional non-scale baseline some users track
  // instead of, or alongside, weight.
  waist?: { value: number; unit: LengthUnit };

  // goal: review logic + experiment selection — defines what "progress"
  // means for this user; directly shapes synthesis framing and which
  // experiments are even relevant to propose. Required, at least one.
  goals: ProfileGoalInput[];

  // personal reason: review logic — grounds the synthesis's tone and
  // framing in the user's own stated motivation (personalization).
  personalReason?: string;

  // typical eating pattern: review logic — baseline this week's meal
  // observations are compared against.
  typicalEatingPattern?: string;

  // typical sleep pattern: review logic — baseline for judging whether
  // this week's sleep observations are normal for this user or a
  // deviation worth noting.
  typicalSleepPattern?: string;

  // typical activity pattern: review logic + experiment selection —
  // baseline for interpreting activity observations, and for proposing
  // experiments that actually fit the user's existing routine.
  typicalActivityPattern?: string;

  // exercise preferences: experiment selection — constrains which
  // activity-based experiments are plausible or appealing to propose.
  exercisePreferences?: string[];

  // physical limitations: safety logic — experiment selection must avoid
  // recommending activities that could cause harm given stated
  // limitations.
  physicalLimitations?: string[];

  // health context: safety logic — high-level context for the safety
  // check and synthesis engine; deliberately NOT a detailed medical
  // history (explicitly excluded by PRD Section 8.2).
  healthContext?: string;

  // weight-management medication flag: review logic — medication context
  // changes how appetite/weight changes should be interpreted (see the
  // eval-harness rubric's "medication awareness" dimension); safety logic
  // — informs when NOT to suggest restriction-based experiments. Required
  // as an explicit boolean — no silent default, since "unanswered" and
  // "no" are not the same thing for a field this safety-relevant.
  onWeightManagementMedication: boolean;
}

// Same shape, but every field optional — an edit only needs to carry what's
// changing; validation.ts merges it onto the current version before
// re-validating the merged result against ParticipantProfileInput's rules.
export type ParticipantProfileEditInput = Partial<ParticipantProfileInput>;
