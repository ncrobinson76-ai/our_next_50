// Hand-rolled, no validation library — consistent with the rest of this
// package. Deliberately light: Observation is polymorphic by type (see
// packages/db's schema comment), so this validates shape/type generically
// rather than re-implementing per-type business rules nothing has asked
// for yet.

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const TIME_OF_DAY_VALUES = ["morning", "afternoon", "evening", "unspecified"] as const;
const CONFIDENCE_LEVEL_VALUES = ["measured", "user_reported", "approximate"] as const;

export interface ObservationCorrectionInput {
  observedDate?: string;
  timeOfDay?: (typeof TIME_OF_DAY_VALUES)[number];
  value?: number;
  unit?: string;
  textValue?: string;
  structuredDetails?: Record<string, unknown>;
  isExplicitNonEvent?: boolean;
  confidenceLevel?: (typeof CONFIDENCE_LEVEL_VALUES)[number];
  correctionReason?: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isValidIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  return !Number.isNaN(new Date(v).getTime());
}

export function parseCorrectionInput(body: unknown): ValidationResult<ObservationCorrectionInput> {
  if (!isPlainObject(body)) {
    return { ok: false, errors: ["request body must be an object"] };
  }
  const errors: string[] = [];
  const value: ObservationCorrectionInput = {};

  if (body.observedDate !== undefined) {
    if (!isValidIsoDate(body.observedDate)) errors.push("observedDate must be an ISO date (YYYY-MM-DD)");
    else value.observedDate = body.observedDate;
  }
  if (body.timeOfDay !== undefined) {
    if (typeof body.timeOfDay !== "string" || !(TIME_OF_DAY_VALUES as readonly string[]).includes(body.timeOfDay)) {
      errors.push(`timeOfDay must be one of ${TIME_OF_DAY_VALUES.join(", ")}`);
    } else {
      value.timeOfDay = body.timeOfDay as ObservationCorrectionInput["timeOfDay"];
    }
  }
  if (body.value !== undefined) {
    if (typeof body.value !== "number" || !Number.isFinite(body.value)) errors.push("value must be a number");
    else value.value = body.value;
  }
  if (body.unit !== undefined) {
    if (typeof body.unit !== "string" || body.unit.trim().length === 0) errors.push("unit must be a non-empty string");
    else value.unit = body.unit;
  }
  if (body.textValue !== undefined) {
    if (typeof body.textValue !== "string" || body.textValue.trim().length === 0) errors.push("textValue must be a non-empty string");
    else value.textValue = body.textValue;
  }
  if (body.structuredDetails !== undefined) {
    if (!isPlainObject(body.structuredDetails)) errors.push("structuredDetails must be an object");
    else value.structuredDetails = body.structuredDetails;
  }
  if (body.isExplicitNonEvent !== undefined) {
    if (typeof body.isExplicitNonEvent !== "boolean") errors.push("isExplicitNonEvent must be a boolean");
    else value.isExplicitNonEvent = body.isExplicitNonEvent;
  }
  if (body.confidenceLevel !== undefined) {
    if (
      typeof body.confidenceLevel !== "string" ||
      !(CONFIDENCE_LEVEL_VALUES as readonly string[]).includes(body.confidenceLevel)
    ) {
      errors.push(`confidenceLevel must be one of ${CONFIDENCE_LEVEL_VALUES.join(", ")}`);
    } else {
      value.confidenceLevel = body.confidenceLevel as ObservationCorrectionInput["confidenceLevel"];
    }
  }
  if (body.correctionReason !== undefined) {
    if (typeof body.correctionReason !== "string" || body.correctionReason.trim().length === 0) {
      errors.push("correctionReason must be a non-empty string");
    } else {
      value.correctionReason = body.correctionReason;
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  if (Object.keys(value).filter((k) => k !== "correctionReason").length === 0) {
    return { ok: false, errors: ["at least one field to correct is required"] };
  }

  return { ok: true, value };
}
