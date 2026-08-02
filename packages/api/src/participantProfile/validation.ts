import type { ParticipantProfileEditInput, ParticipantProfileInput, ProfileGoalInput } from "./types";

// Hand-rolled, no validation library — this project adds dependencies only
// when asked. Doubles as the field allowlist: any key on the request body
// that isn't explicitly read below is silently dropped, never reaches the
// database. That's what keeps this route from accidentally growing beyond
// PRD Section 8.2 just because packages/db's schema has room for more.

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const GOAL_TYPES = ["weight-loss", "weight-gain", "maintenance", "body-composition", "other"] as const;
const WEIGHT_UNITS = ["lb", "kg"] as const;
const LENGTH_UNITS = ["in", "cm"] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((item) => typeof item === "string");
}

function isValidIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const parsed = new Date(v);
  return !Number.isNaN(parsed.getTime());
}

function isWeightUnit(v: unknown): v is (typeof WEIGHT_UNITS)[number] {
  return typeof v === "string" && (WEIGHT_UNITS as readonly string[]).includes(v);
}

function isLengthUnit(v: unknown): v is (typeof LENGTH_UNITS)[number] {
  return typeof v === "string" && (LENGTH_UNITS as readonly string[]).includes(v);
}

function parseMeasurement(
  v: unknown,
  path: string,
  unitCheck: (u: unknown) => boolean,
  unitLabel: string,
  errors: string[]
): { value: number; unit: string } | undefined {
  if (v === undefined) return undefined;
  if (!isPlainObject(v) || !isFiniteNumber(v.value) || !unitCheck(v.unit)) {
    errors.push(`${path} must be { value: number, unit: ${unitLabel} }`);
    return undefined;
  }
  return { value: v.value, unit: v.unit as string };
}

function parseGoal(v: unknown, path: string, errors: string[]): ProfileGoalInput | undefined {
  if (!isPlainObject(v)) {
    errors.push(`${path} must be an object`);
    return undefined;
  }
  const localErrors: string[] = [];
  if (typeof v.type !== "string" || !(GOAL_TYPES as readonly string[]).includes(v.type)) {
    localErrors.push(`${path}.type must be one of ${GOAL_TYPES.join(", ")}`);
  }
  if (!isNonEmptyString(v.description)) {
    localErrors.push(`${path}.description is required`);
  }
  let targetWeight: ProfileGoalInput["targetWeight"];
  if (v.targetWeight !== undefined) {
    const parsed = parseMeasurement(v.targetWeight, `${path}.targetWeight`, isWeightUnit, '"lb" | "kg"', localErrors);
    if (parsed) targetWeight = parsed as { value: number; unit: "lb" | "kg" };
  }
  if (localErrors.length > 0) {
    errors.push(...localErrors);
    return undefined;
  }
  return {
    type: v.type as ProfileGoalInput["type"],
    description: v.description as string,
    targetWeight,
  };
}

function parseGoals(v: unknown, errors: string[]): ProfileGoalInput[] | undefined {
  if (!Array.isArray(v) || v.length === 0) {
    errors.push("goals is required and must be a non-empty array");
    return undefined;
  }
  const goals: ProfileGoalInput[] = [];
  v.forEach((item, i) => {
    const goal = parseGoal(item, `goals[${i}]`, errors);
    if (goal) goals.push(goal);
  });
  return errors.length === 0 ? goals : undefined;
}

/** Full validation for creating the initial (version 1) profile. */
export function parseCreateInput(body: unknown): ValidationResult<ParticipantProfileInput> {
  const errors: string[] = [];
  if (!isPlainObject(body)) {
    return { ok: false, errors: ["request body must be an object"] };
  }

  if (body.dateOfBirth === undefined && body.ageRange === undefined) {
    errors.push("at least one of dateOfBirth or ageRange is required");
  }
  let dateOfBirth: string | undefined;
  if (body.dateOfBirth !== undefined) {
    if (!isValidIsoDate(body.dateOfBirth)) errors.push("dateOfBirth must be an ISO date (YYYY-MM-DD)");
    else dateOfBirth = body.dateOfBirth;
  }
  let ageRange: string | undefined;
  if (body.ageRange !== undefined) {
    if (!isNonEmptyString(body.ageRange)) errors.push("ageRange must be a non-empty string");
    else ageRange = body.ageRange;
  }

  const height = parseMeasurement(body.height, "height", isLengthUnit, '"in" | "cm"', errors) as
    | ParticipantProfileInput["height"]
    | undefined;
  const waist = parseMeasurement(body.waist, "waist", isLengthUnit, '"in" | "cm"', errors) as
    | ParticipantProfileInput["waist"]
    | undefined;

  if (body.startingWeight === undefined) {
    errors.push("startingWeight is required");
  }
  let startingWeight: ParticipantProfileInput["startingWeight"] | undefined;
  if (isPlainObject(body.startingWeight)) {
    const sw = body.startingWeight;
    if (!isFiniteNumber(sw.value) || !isWeightUnit(sw.unit) || !isValidIsoDate(sw.date)) {
      errors.push('startingWeight must be { value: number, unit: "lb" | "kg", date: ISO date }');
    } else {
      startingWeight = { value: sw.value, unit: sw.unit, date: sw.date };
    }
  } else if (body.startingWeight !== undefined) {
    errors.push('startingWeight must be { value: number, unit: "lb" | "kg", date: ISO date }');
  }

  const goals = parseGoals(body.goals, errors);

  if (body.onWeightManagementMedication === undefined) {
    errors.push("onWeightManagementMedication is required (explicit true/false)");
  } else if (typeof body.onWeightManagementMedication !== "boolean") {
    errors.push("onWeightManagementMedication must be a boolean");
  }

  const optionalStrings: Record<string, unknown> = {
    personalReason: body.personalReason,
    typicalEatingPattern: body.typicalEatingPattern,
    typicalSleepPattern: body.typicalSleepPattern,
    typicalActivityPattern: body.typicalActivityPattern,
    healthContext: body.healthContext,
  };
  for (const [key, value] of Object.entries(optionalStrings)) {
    if (value !== undefined && !isNonEmptyString(value)) {
      errors.push(`${key} must be a non-empty string if provided`);
    }
  }

  if (body.exercisePreferences !== undefined && !isStringArray(body.exercisePreferences)) {
    errors.push("exercisePreferences must be an array of strings if provided");
  }
  if (body.physicalLimitations !== undefined && !isStringArray(body.physicalLimitations)) {
    errors.push("physicalLimitations must be an array of strings if provided");
  }

  if (errors.length > 0 || !startingWeight || !goals) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      dateOfBirth,
      ageRange,
      height,
      startingWeight,
      waist,
      goals,
      personalReason: body.personalReason as string | undefined,
      typicalEatingPattern: body.typicalEatingPattern as string | undefined,
      typicalSleepPattern: body.typicalSleepPattern as string | undefined,
      typicalActivityPattern: body.typicalActivityPattern as string | undefined,
      exercisePreferences: body.exercisePreferences as string[] | undefined,
      physicalLimitations: body.physicalLimitations as string[] | undefined,
      healthContext: body.healthContext as string | undefined,
      onWeightManagementMedication: body.onWeightManagementMedication as boolean,
    },
  };
}

/**
 * Partial validation for an edit. Every field is optional here — only
 * fields actually present in the body are validated and returned; the
 * caller merges the result onto the current version before re-validating
 * the merged whole with parseCreateInput's rules (so a merged result can
 * never end up missing a field that's required overall).
 */
export function parseEditInput(body: unknown): ValidationResult<ParticipantProfileEditInput> {
  const errors: string[] = [];
  if (!isPlainObject(body)) {
    return { ok: false, errors: ["request body must be an object"] };
  }

  const value: ParticipantProfileEditInput = {};

  if (body.dateOfBirth !== undefined) {
    if (!isValidIsoDate(body.dateOfBirth)) errors.push("dateOfBirth must be an ISO date (YYYY-MM-DD)");
    else value.dateOfBirth = body.dateOfBirth;
  }
  if (body.ageRange !== undefined) {
    if (!isNonEmptyString(body.ageRange)) errors.push("ageRange must be a non-empty string");
    else value.ageRange = body.ageRange;
  }
  if (body.height !== undefined) {
    const parsed = parseMeasurement(body.height, "height", isLengthUnit, '"in" | "cm"', errors);
    if (parsed) value.height = parsed as ParticipantProfileInput["height"];
  }
  if (body.waist !== undefined) {
    const parsed = parseMeasurement(body.waist, "waist", isLengthUnit, '"in" | "cm"', errors);
    if (parsed) value.waist = parsed as ParticipantProfileInput["waist"];
  }
  if (body.startingWeight !== undefined) {
    if (isPlainObject(body.startingWeight)) {
      const sw = body.startingWeight;
      if (!isFiniteNumber(sw.value) || !isWeightUnit(sw.unit) || !isValidIsoDate(sw.date)) {
        errors.push('startingWeight must be { value: number, unit: "lb" | "kg", date: ISO date }');
      } else {
        value.startingWeight = { value: sw.value, unit: sw.unit, date: sw.date };
      }
    } else {
      errors.push('startingWeight must be { value: number, unit: "lb" | "kg", date: ISO date }');
    }
  }
  if (body.goals !== undefined) {
    const goals = parseGoals(body.goals, errors);
    if (goals) value.goals = goals;
  }
  if (body.onWeightManagementMedication !== undefined) {
    if (typeof body.onWeightManagementMedication !== "boolean") {
      errors.push("onWeightManagementMedication must be a boolean");
    } else {
      value.onWeightManagementMedication = body.onWeightManagementMedication;
    }
  }

  const optionalStringKeys = [
    "personalReason",
    "typicalEatingPattern",
    "typicalSleepPattern",
    "typicalActivityPattern",
    "healthContext",
  ] as const;
  for (const key of optionalStringKeys) {
    const v = body[key];
    if (v !== undefined) {
      if (!isNonEmptyString(v)) errors.push(`${key} must be a non-empty string if provided`);
      else value[key] = v;
    }
  }

  if (body.exercisePreferences !== undefined) {
    if (!isStringArray(body.exercisePreferences)) errors.push("exercisePreferences must be an array of strings if provided");
    else value.exercisePreferences = body.exercisePreferences;
  }
  if (body.physicalLimitations !== undefined) {
    if (!isStringArray(body.physicalLimitations)) errors.push("physicalLimitations must be an array of strings if provided");
    else value.physicalLimitations = body.physicalLimitations;
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value };
}
