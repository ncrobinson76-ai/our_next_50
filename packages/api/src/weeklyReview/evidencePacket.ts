import type { InferSelectModel } from "drizzle-orm";
import type { observations, participantProfiles } from "../db";
import type {
  BaselineProfile,
  DerivedMetrics,
  EvidencePacket,
  MedicationContext,
  Observation as DayObservation,
  WeeklyReflection,
} from "../synthesisCore";
import { computeAverageHungerLevel, computeAverageSleepHours, computeWeightTrend, daysBetweenInclusive } from "../synthesisCore";
import type { ProgramWeekRow } from "./programWeek";

export type ObservationRow = InferSelectModel<typeof observations>;
type ProfileRow = InferSelectModel<typeof participantProfiles>;

// This file maps real DB data (11 polymorphic Observation types, free-form
// structuredDetails, per-row verificationState) into packages/synthesis-
// core's EvidencePacket/Observation shape — a fixed, hand-authored shape
// designed in Package 0 against fictional day-summary fixtures. Two
// deliberate mapping decisions worth calling out:
//
// 1. Confirmed/corrected Observations populate structured fields (weight,
//    sleep, meals, hunger, activity, symptoms) and — for context_reflection
//    — the packet's top-level weeklyReflection. Proposed (unconfirmed)
//    Observations of ANY type never populate a structured field; they're
//    always folded into that day's freeTextNotes as an explicitly hedged
//    sentence ("An unconfirmed entry suggests..."). This is the mechanism
//    that satisfies PRD Section 8.4's confirmed/proposed distinction without
//    changing the shared EvidencePacket type itself (which has no
//    confidence field of its own — see packages/synthesis-core/types.ts).
// 2. Four Observation types (waist, energy, experiment_completion,
//    non_scale_win) have no dedicated field in the shared Observation shape
//    (it predates them). Rather than drop that data, confirmed rows of
//    these types are surfaced as plain factual sentences in freeTextNotes
//    too — just not hedged, since they're trusted.
//
// structuredDetails has no fixed schema (packages/api/src/inbox/
// extraction.ts documents it as freeform, model-decided JSON) — sub-fields
// like a meal's approxCalories or an activity's intensity are read
// opportunistically with a type guard when present, never fabricated when
// absent.

function isWithinWeek(row: ObservationRow, weekStartDate: string, weekEndDate: string): boolean {
  return row.observedDate >= weekStartDate && row.observedDate <= weekEndDate;
}

function isTrusted(row: ObservationRow): boolean {
  return row.verificationState === "confirmed" || row.verificationState === "corrected";
}

function asWeightUnit(unit: string | null): "lb" | "kg" {
  return unit === "kg" ? "kg" : "lb";
}

function readStringDetail(details: unknown, key: string): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  const value = (details as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function readNumberDetail(details: unknown, key: string): number | undefined {
  if (!details || typeof details !== "object") return undefined;
  const value = (details as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}

function describeObservation(row: ObservationRow): string {
  if (row.isExplicitNonEvent) {
    return `an explicit note that no ${row.type.replace(/_/g, " ")} was reported`;
  }
  switch (row.type) {
    case "weight":
      return `a weight of ${row.value ?? "an unspecified value"} ${row.unit ?? ""}`.trim();
    case "waist":
      return `a waist measurement of ${row.value ?? "an unspecified value"} ${row.unit ?? ""}`.trim();
    case "sleep":
      return `${row.value ?? "an unspecified number of"} hours of sleep`;
    case "meal":
      return `a meal: ${row.textValue ?? "(no description)"}`;
    case "hunger":
      return `a hunger level of ${row.value ?? "an unspecified value"}`;
    case "energy":
      return `an energy level of ${row.value ?? row.textValue ?? "an unspecified value"}`;
    case "activity":
      return `activity: ${row.textValue ?? (row.value !== null ? `${row.value} ${row.unit ?? "minutes"}` : "(no description)")}`;
    case "experiment_completion":
      return `an experiment-completion note: ${row.textValue ?? "(no description)"}`;
    case "context_reflection":
      return `a reflection note: ${row.textValue ?? "(no description)"}`;
    case "symptom_safety":
      return `a symptom note: ${row.textValue ?? "(no description)"}`;
    case "non_scale_win":
      return `a non-scale win: ${row.textValue ?? "(no description)"}`;
    default:
      return "a logged entry";
  }
}

function groupByDate(rows: ObservationRow[]): Map<string, ObservationRow[]> {
  const map = new Map<string, ObservationRow[]>();
  for (const row of rows) {
    const list = map.get(row.observedDate) ?? [];
    list.push(row);
    map.set(row.observedDate, list);
  }
  return map;
}

function buildDayObservation(date: string, rows: ObservationRow[]): DayObservation {
  const day: DayObservation = { date };
  const hedgedNotes: string[] = [];
  const factualNotes: string[] = [];
  const meals: NonNullable<DayObservation["meals"]> = [];
  const hunger: NonNullable<DayObservation["hunger"]> = [];
  const activity: NonNullable<DayObservation["activity"]> = [];
  const symptoms: string[] = [];

  // Latest confirmed weight/sleep row wins if a day somehow has more than
  // one (both are singular fields on Observation, unlike meals/hunger/
  // activity which are arrays).
  const confirmedWeightRows = rows
    .filter((r) => r.type === "weight" && isTrusted(r) && !r.isExplicitNonEvent && r.value !== null)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  if (confirmedWeightRows.length > 0) {
    const row = confirmedWeightRows[0];
    day.weight = {
      value: Number(row.value),
      unit: asWeightUnit(row.unit),
      date: row.observedDate,
      timeOfDay: row.timeOfDay ?? undefined,
    };
  }

  const confirmedSleepRows = rows
    .filter((r) => r.type === "sleep" && isTrusted(r) && !r.isExplicitNonEvent && r.value !== null)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  if (confirmedSleepRows.length > 0) {
    const row = confirmedSleepRows[0];
    const quality = readStringDetail(row.structuredDetails, "quality");
    day.sleep = {
      hours: Number(row.value),
      quality: quality === "poor" || quality === "fair" || quality === "good" ? quality : undefined,
    };
  }

  for (const row of rows) {
    if (!isTrusted(row)) {
      // Untrusted weight/sleep rows are NOT "handled above" — the pre-pass
      // above only considers trusted rows for the structured field, so an
      // unconfirmed weight/sleep entry must still reach this hedged path
      // rather than being silently dropped.
      hedgedNotes.push(`An unconfirmed entry suggests ${describeObservation(row)} (not yet confirmed by the user).`);
      continue;
    }

    if (row.type === "weight" || row.type === "sleep") continue; // trusted rows already handled above

    if (row.isExplicitNonEvent) {
      factualNotes.push(`Explicitly reported: no ${row.type.replace(/_/g, " ")} today.`);
      continue;
    }

    switch (row.type) {
      case "meal": {
        const approxCalories = readNumberDetail(row.structuredDetails, "approxCalories");
        meals.push({
          time: row.timeOfDay ?? undefined,
          description: row.textValue ?? "(meal logged, no description)",
          approxCalories,
        });
        break;
      }
      case "hunger": {
        if (row.value !== null) {
          hunger.push({ level: Number(row.value), context: row.textValue ?? undefined });
        }
        break;
      }
      case "activity": {
        const intensityRaw = readStringDetail(row.structuredDetails, "intensity");
        const intensity = intensityRaw === "low" || intensityRaw === "moderate" || intensityRaw === "high" ? intensityRaw : undefined;
        const typeLabel = readStringDetail(row.structuredDetails, "type") ?? row.textValue ?? "activity";
        activity.push({
          type: typeLabel,
          durationMinutes: row.value !== null ? Number(row.value) : undefined,
          intensity,
          notes: row.textValue && row.textValue !== typeLabel ? row.textValue : undefined,
        });
        break;
      }
      case "symptom_safety": {
        symptoms.push(row.textValue ?? describeObservation(row));
        break;
      }
      case "context_reflection":
        // Rolled into the packet's top-level weeklyReflection instead —
        // see buildWeeklyReflection.
        break;
      case "waist":
      case "energy":
      case "experiment_completion":
      case "non_scale_win":
        // No dedicated field on Observation for these — surfaced as plain
        // factual text since they're trusted, not dropped.
        factualNotes.push(`Recorded: ${describeObservation(row)}.`);
        break;
    }
  }

  if (meals.length > 0) day.meals = meals;
  if (hunger.length > 0) day.hunger = hunger;
  if (activity.length > 0) day.activity = activity;
  if (symptoms.length > 0) day.symptoms = symptoms;

  const allNotes = [...factualNotes, ...hedgedNotes];
  if (allNotes.length > 0) day.freeTextNotes = allNotes.join(" ");

  return day;
}

function buildWeeklyReflection(
  weekStartDate: string,
  weekEndDate: string,
  weekRows: ObservationRow[]
): WeeklyReflection {
  const trustedReflections = weekRows
    .filter((r) => r.type === "context_reflection" && isTrusted(r) && !r.isExplicitNonEvent && r.textValue)
    .sort((a, b) => a.observedDate.localeCompare(b.observedDate) || a.createdAt.getTime() - b.createdAt.getTime());

  const reflectionText =
    trustedReflections.length > 0
      ? trustedReflections.map((r) => r.textValue as string).join("\n\n")
      : "No confirmed written weekly reflection was logged this week.";

  return { weekStartDate, weekEndDate, reflectionText };
}

function computeAge(dateOfBirth: string | null): number | undefined {
  if (!dateOfBirth) return undefined;
  const dob = new Date(`${dateOfBirth}T00:00:00.000Z`);
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const hasHadBirthdayThisYear =
    now.getUTCMonth() > dob.getUTCMonth() ||
    (now.getUTCMonth() === dob.getUTCMonth() && now.getUTCDate() >= dob.getUTCDate());
  if (!hasHadBirthdayThisYear) age -= 1;
  return age;
}

function buildBaselineNotes(profile: ProfileRow): string | undefined {
  const parts: string[] = [];
  if (profile.personalReason) parts.push(`Personal reason for starting: ${profile.personalReason}`);
  if (profile.healthContext) parts.push(`Health context: ${profile.healthContext}`);
  if (profile.physicalLimitations && profile.physicalLimitations.length > 0) {
    parts.push(`Physical limitations: ${profile.physicalLimitations.join(", ")}`);
  }
  if (profile.exercisePreferences && profile.exercisePreferences.length > 0) {
    parts.push(`Exercise preferences: ${profile.exercisePreferences.join(", ")}`);
  }
  if (profile.typicalSleepPattern) parts.push(`Typical sleep pattern: ${profile.typicalSleepPattern}`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function buildBaselineProfile(profile: ProfileRow, programStartDate: string): BaselineProfile {
  const primaryGoal = profile.goals[0];
  return {
    userId: profile.userId,
    startDate: programStartDate,
    startingWeight: {
      value: Number(profile.startingWeightValue),
      unit: profile.startingWeightUnit,
      date: profile.startingWeightDate,
    },
    height:
      profile.heightValue !== null && profile.heightUnit !== null
        ? { value: Number(profile.heightValue), unit: profile.heightUnit }
        : undefined,
    age: computeAge(profile.dateOfBirth),
    goal: {
      type: primaryGoal.type,
      description: primaryGoal.description,
      targetWeight: primaryGoal.targetWeight,
    },
    activityBaseline: profile.typicalActivityPattern ?? undefined,
    dietaryPattern: profile.typicalEatingPattern ?? undefined,
    notes: buildBaselineNotes(profile),
  };
}

function buildMedicationContext(profile: ProfileRow): MedicationContext | null {
  if (!profile.onWeightManagementMedication) return null;
  return {
    medications: [
      {
        // PRD Section 8.2 deliberately collects a yes/no flag only — no
        // drug name or dosage — so this is the honest ceiling of what can
        // be reported here, not a placeholder for a missing feature.
        name: "Weight-management medication (specific medication and dosage not collected, per PRD Section 8.2 scope)",
      },
    ],
  };
}

export interface AssembledEvidencePacket {
  packet: EvidencePacket;
  /** Every non-superseded Observation considered (confirmed or proposed) — the audit trail for WeeklyReview.inputSnapshot. */
  includedObservationIds: string[];
}

export function assembleEvidencePacket(
  programWeek: ProgramWeekRow,
  currentProfile: ProfileRow,
  programStartDate: string,
  allObservations: ObservationRow[]
): AssembledEvidencePacket {
  const weekRows = allObservations.filter(
    (row) => !row.isSuperseded && isWithinWeek(row, programWeek.weekStartDate, programWeek.weekEndDate)
  );

  const grouped = groupByDate(weekRows);
  const dayObservations: DayObservation[] = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, rows]) => buildDayObservation(date, rows));

  const weeklyReflection = buildWeeklyReflection(programWeek.weekStartDate, programWeek.weekEndDate, weekRows);

  const derivedMetrics: DerivedMetrics = {
    loggedDayCount: grouped.size,
    totalDayCount: daysBetweenInclusive(programWeek.weekStartDate, programWeek.weekEndDate),
    weightTrend: computeWeightTrend(dayObservations),
    averageSleepHours: computeAverageSleepHours(dayObservations),
    averageHungerLevel: computeAverageHungerLevel(dayObservations),
  };

  const packet: EvidencePacket = {
    // Repurposed from Package 0's fictional "scenario id" to this real
    // ProgramWeek's id — a stable, meaningful identifier for a real weekly
    // packet. The field name is legacy; its meaning here is "which
    // ProgramWeek this packet was built for."
    scenarioId: programWeek.id,
    baseline: buildBaselineProfile(currentProfile, programStartDate),
    observations: dayObservations,
    weeklyReflection,
    // Package 10's job — no Experiment entity is wired into the API yet.
    priorExperiment: null,
    medicationContext: buildMedicationContext(currentProfile),
    derivedMetrics,
  };

  return { packet, includedObservationIds: weekRows.map((row) => row.id) };
}
