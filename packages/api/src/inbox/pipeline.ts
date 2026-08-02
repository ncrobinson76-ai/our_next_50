import type { InferSelectModel } from "drizzle-orm";
import type { inboxEvents } from "../db";
import type { ScopedDataAccess } from "../data/scopedDataAccess";
import { toObservationResponse, type ObservationResponse } from "../observations/mapping";
import { runSafetyScreen, type SafetyPolicyCategory } from "./safetyScreen";
import { extractObservations, type ExtractedObservation } from "./extraction";

type InboxEventRow = InferSelectModel<typeof inboxEvents>;

export const SAFETY_SCREEN_VERSION = "package-5-keyword-screen-v1";

export interface PipelineResult {
  status: "safety_flagged" | "needs_followup" | "processed";
  pathwayMessage?: string;
  followUpQuestion?: string;
  observations?: ObservationResponse[];
}

// INB-01's payoff: the pipeline doesn't branch on channel beyond this one
// adapter step. Every channel (including voice, once Package 6 adds a
// transcript) reduces to a plain text string here, and everything after
// this point — safety screening, extraction, writes — is identical
// regardless of where the text came from.
function payloadToText(channel: string, payload: unknown): string {
  const p = (payload ?? {}) as Record<string, unknown>;

  if (channel === "text") {
    return typeof p.text === "string" ? p.text : "";
  }

  if (channel === "form") {
    const parts: string[] = [];
    const weight = p.weight as { value?: number; unit?: string } | undefined;
    if (typeof weight?.value === "number" && weight.unit) {
      parts.push(`Weight: ${weight.value} ${weight.unit}`);
    }
    if (typeof p.hungerLevel === "number") {
      parts.push(`Hunger level: ${p.hungerLevel}/5`);
    }
    if (typeof p.note === "string" && p.note.trim().length > 0) {
      parts.push(`Note: ${p.note}`);
    }
    return parts.join(". ");
  }

  return "";
}

async function writeSafetyEvents(
  data: ScopedDataAccess,
  event: InboxEventRow,
  categories: SafetyPolicyCategory[]
): Promise<void> {
  for (const category of categories) {
    // Deliberately no "reasons" text stored here (even though eval-harness's
    // ported reasons strings quote the matched phrase) — per PRD Section 11
    // and this package's own instruction, a SafetyEvent row stores category
    // + references, not flagged free text. policyCategory IS the reason at
    // the granularity this table is allowed to keep.
    const insertValues = {
      policyCategory: category,
      pathwayKey: category,
      systemVersion: SAFETY_SCREEN_VERSION,
      sourceInboxEventId: event.id,
    };
    await data.safetyEvents.create(insertValues);
  }
}

async function writeObservations(
  data: ScopedDataAccess,
  event: InboxEventRow,
  extracted: ExtractedObservation[]
): Promise<ObservationResponse[]> {
  const created: ObservationResponse[] = [];
  for (const obs of extracted) {
    const insertValues = {
      type: obs.type,
      observedDate: obs.observedDate,
      timeOfDay: obs.timeOfDay ?? null,
      value: obs.value !== undefined ? String(obs.value) : null,
      unit: obs.unit ?? null,
      textValue: obs.textValue ?? null,
      structuredDetails: obs.structuredDetails ?? null,
      isExplicitNonEvent: obs.isExplicitNonEvent,
      confidenceLevel: obs.confidenceLevel,
      // Nothing in this pipeline ever auto-confirms — every extracted
      // Observation starts "proposed" regardless of how unambiguous it
      // seemed to the model. Confirming is always a separate user action
      // (INB-07, see routes/observations.ts).
      verificationState: "proposed" as const,
      sourceInboxEventId: event.id,
    };
    const row = await data.observations.create(insertValues);
    created.push(toObservationResponse(row));
  }
  return created;
}

/**
 * Runs the full per-entry pipeline: safety screen first (PRD Section 9),
 * short-circuiting before any LLM call if flagged (PRD Section 10
 * containment — mirrors the pattern already proven in Package 0's
 * synthesizeWeek()); extraction only if not flagged. Callers (routes/
 * inbox.ts) are responsible for checking the InboxEvent's current status
 * before calling this — this function assumes it's valid to run.
 *
 * @param followUpAnswer when set, this is the second/final pass after
 *   INB-06's one allowed follow-up question was answered — the answer is
 *   included as extra context, safety-screened again (it's new user text),
 *   and the pipeline is not allowed to ask another follow-up regardless of
 *   what the model returns (enforced in extraction.ts, not just prompted).
 */
export async function runPipeline(
  data: ScopedDataAccess,
  event: InboxEventRow,
  followUpAnswer?: string
): Promise<PipelineResult> {
  const baseText = payloadToText(event.channel, event.payload);
  const text = followUpAnswer ? `${baseText}\n\nFollow-up answer: ${followUpAnswer}` : baseText;

  const screen = runSafetyScreen(text);
  if (screen.flagged) {
    await writeSafetyEvents(data, event, screen.categories);
    await data.inboxEvents.update(event.id, {
      status: "safety_flagged",
      processedAt: new Date(),
      pendingFollowUpQuestion: null,
    });
    return { status: "safety_flagged", pathwayMessage: screen.pathwayMessage };
  }

  const referenceDate = event.receivedAt.toISOString().slice(0, 10);
  const extraction = await extractObservations(text, referenceDate, followUpAnswer);

  if (extraction.followUpQuestion && !followUpAnswer) {
    await data.inboxEvents.update(event.id, {
      status: "needs_followup",
      pendingFollowUpQuestion: extraction.followUpQuestion,
    });
    return { status: "needs_followup", followUpQuestion: extraction.followUpQuestion };
  }

  const createdObservations = await writeObservations(data, event, extraction.observations);
  await data.inboxEvents.update(event.id, {
    status: "processed",
    processedAt: new Date(),
    pendingFollowUpQuestion: null,
  });
  return { status: "processed", observations: createdObservations };
}
