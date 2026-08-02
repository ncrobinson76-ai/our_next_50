import type { FormPayload, TextPayload, WeightUnit } from "./types";

// Hand-rolled, no validation library — consistent with
// participantProfile/validation.ts.

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isWeightUnit(v: unknown): v is WeightUnit {
  return v === "lb" || v === "kg";
}

export function parseTextPayload(body: unknown): ValidationResult<TextPayload> {
  if (!isPlainObject(body)) {
    return { ok: false, errors: ["request body must be an object"] };
  }
  const { text } = body;
  if (typeof text !== "string" || text.trim().length === 0) {
    return { ok: false, errors: ["text is required and must be a non-empty string"] };
  }
  return { ok: true, value: { text } };
}

export function parseFormPayload(body: unknown): ValidationResult<FormPayload> {
  if (!isPlainObject(body)) {
    return { ok: false, errors: ["request body must be an object"] };
  }
  const errors: string[] = [];
  const value: FormPayload = {};

  if (body.weight !== undefined) {
    const w = body.weight;
    if (!isPlainObject(w) || !isFiniteNumber(w.value) || !isWeightUnit(w.unit)) {
      errors.push('weight must be { value: number, unit: "lb" | "kg" } if provided');
    } else {
      value.weight = { value: w.value, unit: w.unit };
    }
  }

  if (body.hungerLevel !== undefined) {
    const h = body.hungerLevel;
    if (!isFiniteNumber(h) || !Number.isInteger(h) || h < 1 || h > 5) {
      errors.push("hungerLevel must be an integer from 1 to 5 if provided");
    } else {
      value.hungerLevel = h;
    }
  }

  if (body.note !== undefined) {
    if (typeof body.note !== "string" || body.note.trim().length === 0) {
      errors.push("note must be a non-empty string if provided");
    } else {
      value.note = body.note;
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  if (value.weight === undefined && value.hungerLevel === undefined && value.note === undefined) {
    return { ok: false, errors: ["at least one of weight, hungerLevel, or note is required"] };
  }

  return { ok: true, value };
}
