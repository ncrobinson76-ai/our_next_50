import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import type { participantProfiles } from "../db";
import type { ParticipantProfileInput } from "./types";

type ProfileRow = InferSelectModel<typeof participantProfiles>;
type ProfileInsert = Omit<InferInsertModel<typeof participantProfiles>, "userId">;

// DB numeric columns are string-typed (Drizzle's default for `numeric`, to
// avoid float precision loss) — converted to/from JS numbers at this
// boundary so the API deals in numbers and the DB deals in exact strings.

export function toDbInsert(input: ParticipantProfileInput, version: number): ProfileInsert {
  return {
    version,
    dateOfBirth: input.dateOfBirth ?? null,
    ageRange: input.ageRange ?? null,
    heightValue: input.height ? String(input.height.value) : null,
    heightUnit: input.height?.unit ?? null,
    startingWeightValue: String(input.startingWeight.value),
    startingWeightUnit: input.startingWeight.unit,
    startingWeightDate: input.startingWeight.date,
    waistValue: input.waist ? String(input.waist.value) : null,
    waistUnit: input.waist?.unit ?? null,
    goals: input.goals,
    personalReason: input.personalReason ?? null,
    typicalEatingPattern: input.typicalEatingPattern ?? null,
    typicalSleepPattern: input.typicalSleepPattern ?? null,
    typicalActivityPattern: input.typicalActivityPattern ?? null,
    exercisePreferences: input.exercisePreferences ?? null,
    physicalLimitations: input.physicalLimitations ?? null,
    healthContext: input.healthContext ?? null,
    onWeightManagementMedication: input.onWeightManagementMedication,
  };
}

export interface ParticipantProfileResponse {
  id: string;
  version: number;
  dateOfBirth: string | null;
  ageRange: string | null;
  height: { value: number; unit: string } | null;
  startingWeight: { value: number; unit: string; date: string };
  waist: { value: number; unit: string } | null;
  goals: ParticipantProfileInput["goals"];
  personalReason: string | null;
  typicalEatingPattern: string | null;
  typicalSleepPattern: string | null;
  typicalActivityPattern: string | null;
  exercisePreferences: string[] | null;
  physicalLimitations: string[] | null;
  healthContext: string | null;
  onWeightManagementMedication: boolean;
  createdAt: Date;
}

// Converts a stored row back into the ParticipantProfileInput shape (nulls
// become undefined) so an edit can be computed as
// `{ ...toInputShape(currentRow), ...editPartial }` and re-validated with
// parseCreateInput before being persisted as the next version.
export function toInputShape(row: ProfileRow): ParticipantProfileInput {
  return {
    dateOfBirth: row.dateOfBirth ?? undefined,
    ageRange: row.ageRange ?? undefined,
    height:
      row.heightValue !== null && row.heightUnit !== null
        ? { value: Number(row.heightValue), unit: row.heightUnit }
        : undefined,
    startingWeight: {
      value: Number(row.startingWeightValue),
      unit: row.startingWeightUnit,
      date: row.startingWeightDate,
    },
    waist:
      row.waistValue !== null && row.waistUnit !== null
        ? { value: Number(row.waistValue), unit: row.waistUnit }
        : undefined,
    goals: row.goals,
    personalReason: row.personalReason ?? undefined,
    typicalEatingPattern: row.typicalEatingPattern ?? undefined,
    typicalSleepPattern: row.typicalSleepPattern ?? undefined,
    typicalActivityPattern: row.typicalActivityPattern ?? undefined,
    exercisePreferences: row.exercisePreferences ?? undefined,
    physicalLimitations: row.physicalLimitations ?? undefined,
    healthContext: row.healthContext ?? undefined,
    onWeightManagementMedication: row.onWeightManagementMedication,
  };
}

export function fromDbRow(row: ProfileRow): ParticipantProfileResponse {
  return {
    id: row.id,
    version: row.version,
    dateOfBirth: row.dateOfBirth,
    ageRange: row.ageRange,
    height: row.heightValue !== null && row.heightUnit !== null ? { value: Number(row.heightValue), unit: row.heightUnit } : null,
    startingWeight: {
      value: Number(row.startingWeightValue),
      unit: row.startingWeightUnit,
      date: row.startingWeightDate,
    },
    waist: row.waistValue !== null && row.waistUnit !== null ? { value: Number(row.waistValue), unit: row.waistUnit } : null,
    goals: row.goals,
    personalReason: row.personalReason,
    typicalEatingPattern: row.typicalEatingPattern,
    typicalSleepPattern: row.typicalSleepPattern,
    typicalActivityPattern: row.typicalActivityPattern,
    exercisePreferences: row.exercisePreferences,
    physicalLimitations: row.physicalLimitations,
    healthContext: row.healthContext,
    onWeightManagementMedication: row.onWeightManagementMedication,
    createdAt: row.createdAt,
  };
}
