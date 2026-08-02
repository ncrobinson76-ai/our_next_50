// Hand-rolled, no validation library — consistent with the rest of this package.

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isValidIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  return !Number.isNaN(new Date(v).getTime());
}

export interface ModifyInput {
  recommendation: string;
}

export function parseModifyInput(body: unknown): ValidationResult<ModifyInput> {
  if (!isPlainObject(body)) return { ok: false, errors: ["request body must be an object"] };
  if (typeof body.recommendation !== "string" || body.recommendation.trim().length === 0) {
    return { ok: false, errors: ["recommendation must be a non-empty string"] };
  }
  return { ok: true, value: { recommendation: body.recommendation } };
}

export interface RetireInput {
  outcome?: string;
}

export function parseRetireInput(body: unknown): ValidationResult<RetireInput> {
  if (body === undefined || body === null || (isPlainObject(body) && Object.keys(body).length === 0)) {
    return { ok: true, value: {} };
  }
  if (!isPlainObject(body)) return { ok: false, errors: ["request body must be an object"] };
  if (body.outcome !== undefined) {
    if (typeof body.outcome !== "string" || body.outcome.trim().length === 0) {
      return { ok: false, errors: ["outcome must be a non-empty string"] };
    }
    return { ok: true, value: { outcome: body.outcome } };
  }
  return { ok: true, value: {} };
}

export interface LogCompletionInput {
  completed: boolean;
  date: string;
  note?: string;
}

export function parseLogCompletionInput(body: unknown): ValidationResult<LogCompletionInput> {
  if (!isPlainObject(body)) return { ok: false, errors: ["request body must be an object"] };
  const errors: string[] = [];

  if (typeof body.completed !== "boolean") errors.push("completed must be a boolean");
  if (!isValidIsoDate(body.date)) errors.push("date must be an ISO date (YYYY-MM-DD)");
  if (body.note !== undefined && (typeof body.note !== "string" || body.note.trim().length === 0)) {
    errors.push("note must be a non-empty string when provided");
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      completed: body.completed as boolean,
      date: body.date as string,
      note: body.note as string | undefined,
    },
  };
}
