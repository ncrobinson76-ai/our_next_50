import Anthropic from "@anthropic-ai/sdk";

// Package 5's extraction step (PRD Section 9, only runs if the safety
// screen didn't flag the entry). Same getClient()/system-prompt/JSON-
// parsing pattern as packages/eval-harness/synthesisEngine.ts, but the
// job is different: extract typed candidate Observations from ONE entry,
// not synthesize a week. New dependency for this package: @anthropic-ai/sdk
// (explicitly directed by this package's spec, same as eval-harness).

const DEFAULT_MODEL = "claude-sonnet-5";
const MAX_TOKENS = 2048;

let cachedClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!cachedClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is not set. Copy .env.example to .env and fill it in.");
    }
    cachedClient = new Anthropic({ apiKey });
  }
  return cachedClient;
}

export const OBSERVATION_TYPES = [
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
] as const;
export type ObservationType = (typeof OBSERVATION_TYPES)[number];

export const CONFIDENCE_LEVELS = ["measured", "user_reported", "approximate"] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export interface ExtractedObservation {
  type: ObservationType;
  observedDate: string; // YYYY-MM-DD, resolved against the reference date given in the prompt
  timeOfDay?: "morning" | "afternoon" | "evening" | "unspecified";
  value?: number;
  unit?: string;
  textValue?: string;
  structuredDetails?: Record<string, unknown>;
  isExplicitNonEvent: boolean;
  confidenceLevel: ConfidenceLevel;
}

export interface ExtractionResult {
  observations: ExtractedObservation[];
  /** At most one, per INB-06 — null if none is warranted. */
  followUpQuestion: string | null;
}

const SYSTEM_PROMPT = `You are the entry-extraction engine for "Our Next 50," a conversational health app.

You will receive ONE piece of user-submitted text (a free-form message, or the note field from a quick structured check-in) plus a reference date. Your job is to extract zero or more typed candidate Observations from it, as JSON with exactly these keys:

- "observations": an array, each item shaped as:
  - "type": one of exactly these 11 values: "weight", "waist", "sleep", "meal", "hunger", "energy", "activity", "experiment_completion", "context_reflection", "symptom_safety", "non_scale_win"
  - "observedDate": ISO date (YYYY-MM-DD), resolved against the reference date (e.g. "yesterday" / "last night" / "this morning" relative to it). Default to the reference date if the text gives no date cue.
  - "timeOfDay": one of "morning" | "afternoon" | "evening" | "unspecified", omit if not indicated.
  - "value": a number, only when the observation has a single primary numeric magnitude (a weight, sleep hours, a hunger/energy level, an activity duration). Omit otherwise.
  - "unit": the unit for "value" (e.g. "lb", "kg", "hours", "level", "minutes"). Omit if "value" is omitted.
  - "textValue": free-text content for observations that are fundamentally narrative (a meal description, a reflection, a symptom description, a non-scale win). Omit for purely numeric observations.
  - "structuredDetails": an object for any type-specific extra structure (e.g. a meal's approxCalories, an activity's intensity), omit if nothing extra applies.
  - "isExplicitNonEvent": true only when the text explicitly reports that something did NOT happen (e.g. "didn't work out today", "skipped dinner") — false for a normal positive observation. Absence of a mention is never represented as an observation at all; this field is only for an explicit negative statement.
  - "confidenceLevel": one of "measured" | "user_reported" | "approximate". A precise stated figure (e.g. "172.4 lbs") is "measured". A self-reported but non-precise statement (e.g. "felt pretty hungry", "slept badly") is "user_reported" with approximate framing — never mark an inferred or vague value as "measured".
- "followUpQuestion": a single string, or null. You may propose AT MOST ONE follow-up question, and only if answering it would materially improve safety or interpretation (e.g. a genuinely ambiguous date that changes which day an observation applies to, or a symptom mention that needs a clarifying detail) — never to demand precision on a low-value detail. If nothing meets that bar, this must be null. Never propose more than one question under any circumstances.

Hard rules:
1. Never invent a fact not present in the source text. Do not invent meals, measurements, motives, causes, or events that are not present in the text.
2. If the text contains nothing extractable, return an empty observations array — do not force an observation to exist.
3. Every "type" must be exactly one of the 11 listed values — do not invent new types.
4. Output ONLY the JSON object described above. No markdown fences, no prose before or after it.`;

function buildUserMessage(text: string, referenceDate: string, followUpAnswer?: string): string {
  let message = `Reference date: ${referenceDate}\n\nEntry text:\n${text}`;
  if (followUpAnswer) {
    message += `\n\nThe user was asked a follow-up question and answered:\n${followUpAnswer}\n\nThis is the final pass — do not propose another follow-up question regardless of remaining ambiguity; extract your best understanding using everything above.`;
  }
  message += "\n\nProduce the structured extraction JSON as instructed.";
  return message;
}

function extractJsonBlock(text: string): string {
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch) return fencedMatch[1].trim();

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1);
  }
  return text.trim();
}

function parseModelResponse(rawText: string): ExtractionResult {
  const jsonText = extractJsonBlock(rawText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(
      `Failed to parse model response as JSON: ${(err as Error).message}\n\nRaw response:\n${rawText}`
    );
  }
  const result = parsed as Partial<ExtractionResult>;
  return {
    observations: Array.isArray(result.observations) ? result.observations : [],
    followUpQuestion: result.followUpQuestion ?? null,
  };
}

/**
 * @param text the entry's free text
 * @param referenceDate ISO date the InboxEvent was received, for resolving relative dates
 * @param followUpAnswer if set, this is the second/final pass after a follow-up question was
 *   answered — the model is instructed not to propose another one, and this function discards
 *   any followUpQuestion it returns anyway, so "at most one" is enforced in code, not just prompt.
 */
export async function extractObservations(
  text: string,
  referenceDate: string,
  followUpAnswer?: string
): Promise<ExtractionResult> {
  const client = getClient();
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

  const response = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserMessage(text, referenceDate, followUpAnswer) }],
  });

  if (response.stop_reason === "max_tokens") {
    throw new Error(`Response truncated at max_tokens (${MAX_TOKENS}). Raise MAX_TOKENS or shorten the prompt.`);
  }

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Model response contained no text block.");
  }

  const result = parseModelResponse(textBlock.text);

  if (followUpAnswer) {
    // Structural enforcement of "at most one follow-up, ever" for the
    // second pass — never trust the model to police this on its own.
    return { ...result, followUpQuestion: null };
  }
  return result;
}
