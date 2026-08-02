// The weekly-synthesis LLM call: system prompt, request/response handling.
// Moved here unmodified from packages/eval-harness in Package 9 so
// packages/api can call the exact same, rubric-validated prompt logic
// against real EvidencePackets. THE SYSTEM_PROMPT TEXT BELOW MUST NOT BE
// EDITED — it was rubric-scored across 16 fictional scenarios in Package 0;
// a changed prompt is an unvalidated prompt.
//
// What moved here vs. what stayed in packages/eval-harness: building an
// EvidencePacket from a *scenario* (packages/eval-harness/synthesisEngine.ts's
// old buildEvidencePacket(scenario)) is specific to how the eval harness's
// fictional fixtures are shaped and has no meaning for real data, so it
// stayed put. Everything downstream of "I already have an EvidencePacket" —
// the safety check, the LLM call, response parsing — is identical
// regardless of how the packet was built, so it lives here as
// synthesizeFromPacket(). Both callers now do:
//   const packet = <their own domain-specific packet builder>(...);
//   const result = await synthesizeFromPacket(packet);

import Anthropic from "@anthropic-ai/sdk";
import { runSafetyCheck } from "./safetyCheck";
import { EvidencePacket, ProposedNextStep, SynthesisOutput } from "./types";

const DEFAULT_MODEL = "claude-sonnet-5";
const MAX_TOKENS = 4096;

let cachedClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!cachedClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set. Copy .env.example to .env and fill it in."
      );
    }
    cachedClient = new Anthropic({ apiKey });
  }
  return cachedClient;
}

const SYSTEM_PROMPT = `You are the weekly-synthesis engine for "Our Next 50," a conversational health app.

You will receive one EvidencePacket as JSON: a user's baseline profile, this week's daily observations, their written weekly reflection, the prior week's experiment (if any), and medication context (if any).

Your job is to produce a structured weekly synthesis as JSON, with these exact keys:
- "recordedFacts": string[] — objective facts taken directly from the evidence packet (e.g. logged weights, sleep hours, meals, medications). No interpretation.
- "observationsSummary": string[] — neutral pattern descriptions directly traceable to the recorded facts (e.g. "weight was logged on 5 of 7 days").
- "tentativeHypotheses": string[] — possible explanations for the observed pattern, clearly framed as tentative (e.g. "may be related to..."), never asserted as certain.
- "whatsWorking": string[] — behaviors the evidence suggests are going well and worth preserving. Empty array if evidence doesn't support any.
- "friction": string[] — obstacles or difficulties the evidence suggests the user is experiencing. Empty array if none are evident.
- "whatShouldRemainUnchanged": string[] — things explicitly called out as worth keeping as-is.
- "proposedNextStep": { "type": "experiment" | "no-change" | "insufficient-evidence", "description": string } — exactly one proposed next step. Use "no-change" when the evidence supports staying the course, and "insufficient-evidence" when the data is too sparse or contradictory to respond to, explaining what's missing.

Hard rules:
1. Every claim in every section must trace back to something in the EvidencePacket. Never invent meals, measurements, motives, causes, or events that are not present in the data.
2. If data is sparse, missing, or contradictory, say so explicitly and prefer "insufficient-evidence" or restraint over guessing.
3. Do not suggest medication changes, even when medication context is present — you may note how medication context affects interpretation of the data, but medication decisions are out of scope.
4. Tone: calm, adult, hopeful, nonjudgmental. Never moralize food choices, use failure language, or state false certainty.
5. The proposed next step (if type is "experiment") must be specific, measurable, and logically tied to evidence already in the packet — not generic advice.
6. Output ONLY the JSON object described above. No markdown fences, no prose before or after it.`;

function buildUserMessage(packet: EvidencePacket): string {
  return `Here is this week's EvidencePacket:\n\n${JSON.stringify(packet, null, 2)}\n\nProduce the structured weekly synthesis JSON as instructed.`;
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

interface ParsedModelSynthesis {
  recordedFacts: string[];
  observationsSummary: string[];
  tentativeHypotheses: string[];
  whatsWorking: string[];
  friction: string[];
  whatShouldRemainUnchanged: string[];
  proposedNextStep: ProposedNextStep;
}

function parseModelResponse(rawText: string): ParsedModelSynthesis {
  const jsonText = extractJsonBlock(rawText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(
      `Failed to parse model response as JSON: ${(err as Error).message}\n\nRaw response:\n${rawText}`
    );
  }
  return parsed as ParsedModelSynthesis;
}

async function callSynthesisModel(packet: EvidencePacket): Promise<string> {
  const client = getClient();
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

  const response = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserMessage(packet) }],
  });

  if (response.stop_reason === "max_tokens") {
    throw new Error(
      `Response truncated at max_tokens (${MAX_TOKENS}). Raise MAX_TOKENS or shorten the prompt.`
    );
  }

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Model response contained no text block.");
  }
  return textBlock.text;
}

/**
 * Runs the safety check against an already-assembled EvidencePacket and,
 * if not flagged, calls the synthesis model. Short-circuits before any LLM
 * call when flagged — same discipline as every other safety gate in this
 * build (packages/api's per-entry safetyScreen.ts included).
 */
export async function synthesizeFromPacket(packet: EvidencePacket): Promise<SynthesisOutput> {
  const safetyCheck = runSafetyCheck(packet);

  if (safetyCheck.flagged) {
    const safetyNextStep: ProposedNextStep = {
      type: "no-change",
      description:
        safetyCheck.pathwayMessage ??
        "This week's entry was flagged for safety review instead of normal coaching.",
    };

    return {
      scenarioId: packet.scenarioId,
      safetyCheck,
      safetyPathwayTriggered: true,
      recordedFacts: [],
      observationsSummary: [],
      tentativeHypotheses: [],
      whatsWorking: [],
      friction: [],
      whatShouldRemainUnchanged: [],
      proposedNextStep: safetyNextStep,
    };
  }

  const rawModelResponse = await callSynthesisModel(packet);
  const parsed = parseModelResponse(rawModelResponse);

  return {
    scenarioId: packet.scenarioId,
    safetyCheck,
    safetyPathwayTriggered: false,
    recordedFacts: parsed.recordedFacts ?? [],
    observationsSummary: parsed.observationsSummary ?? [],
    tentativeHypotheses: parsed.tentativeHypotheses ?? [],
    whatsWorking: parsed.whatsWorking ?? [],
    friction: parsed.friction ?? [],
    whatShouldRemainUnchanged: parsed.whatShouldRemainUnchanged ?? [],
    proposedNextStep: parsed.proposedNextStep,
    rawModelResponse,
  };
}
