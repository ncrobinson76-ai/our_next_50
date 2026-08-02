// Package 8: hardens the safety screen built in Package 5
// (packages/api/src/inbox/safetyScreen.ts). This file covers what
// changed here specifically — expanded keyword coverage, two new
// categories, and the rapid-weight-change gap closed. It does NOT
// re-test the pipeline's control flow (screen-before-extraction, hard
// short-circuit) — that's Package 5's job, untouched by this package, and
// already covered by test/extraction.test.ts, which is re-run unmodified
// as part of the full suite alongside this file to confirm nothing
// regressed.
//
// Most of this file is pure unit tests against runSafetyScreen() directly
// — no server, no DB, no LLM calls needed for keyword-matching
// correctness. The rapid-weight-change section is the exception: it's a
// computed comparison against a user's own history, so it needs a real
// pipeline run (same as Package 5's pattern) — that part does make a real
// Anthropic extraction call, same as every other pipeline integration
// test in this package.
import * as dotenv from "dotenv";
dotenv.config();
process.env.NODE_ENV = "test";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { db, users, observations, safetyEvents, participantProfiles } from "../src/db";
import { CURRENT_CONSENT_VERSION } from "../src/consent";
import { runSafetyScreen } from "../src/inbox/safetyScreen";

// --- Unit tests: keyword expansion, new categories, calibration, wording ---

test("urgent_symptom: expanded coverage catches dizziness (not in the original list)", () => {
  const result = runSafetyScreen("Felt really dizzy after climbing the stairs today.");
  assert.equal(result.flagged, true);
  assert.deepEqual(result.categories, ["urgent_symptom"]);
});

test("crisis_language: expanded coverage catches a direct clinical term (original list had only euphemisms)", () => {
  const result = runSafetyScreen("I've been having thoughts of suicide lately.");
  assert.equal(result.flagged, true);
  assert.ok(result.categories.includes("crisis_language"));
});

test("disordered_eating: catches the concrete per-entry gap found cross-checking eval-harness's scenario text", () => {
  // From packages/eval-harness/scenarios/possible-disordered-eating-language.json's
  // per-day freeTextNotes — as its own InboxEvent, separate from the day
  // that mentions "binged"/"don't deserve to eat", none of the original
  // keywords matched this sentence.
  const result = runSafetyScreen("Trying to make up for Tuesday still.");
  assert.equal(result.flagged, true);
  assert.ok(result.categories.includes("disordered_eating"));
});

test("pregnancy_related: new category flags correctly with its own distinct message", () => {
  const result = runSafetyScreen("I just found out I'm pregnant and I'm not sure how this changes things.");
  assert.equal(result.flagged, true);
  assert.deepEqual(result.categories, ["pregnancy_related"]);
  const message = result.pathwayMessage!.toLowerCase();
  assert.ok(message.includes("pregnan"));
  assert.ok(message.includes("ob/gyn") || message.includes("prenatal"));
});

test("extreme_restriction: new category flags correctly with its own distinct message", () => {
  const result = runSafetyScreen("I panic if I miss a workout, I feel like I have to exercise no matter what.");
  assert.equal(result.flagged, true);
  assert.ok(result.categories.includes("extreme_restriction"));
  assert.ok(result.pathwayMessage);
});

test("extreme_restriction and disordered_eating are kept as distinct categories with distinct messages", () => {
  const restriction = runSafetyScreen("I have to work out every single day no matter what.");
  const eating = runSafetyScreen("I binged today and don't deserve to eat tomorrow.");
  assert.ok(restriction.categories.includes("extreme_restriction"));
  assert.ok(!restriction.categories.includes("disordered_eating"));
  assert.ok(eating.categories.includes("disordered_eating"));
  assert.ok(!eating.categories.includes("extreme_restriction"));
  assert.notEqual(restriction.pathwayMessage, eating.pathwayMessage);
});

test("calibration: eval-harness's very-high-hunger-unwise-to-restrict scenario text does not trigger extreme_restriction", () => {
  // This scenario (someone training hard for a 5K, considering "cutting
  // my portions down" because hunger is intense) is explicitly meant to
  // get normal restraint-oriented coaching, not a safety short-circuit.
  // If this test ever fails, the keyword list has drifted too broad.
  const text =
    "I ran a lot this week training for a race and I've been really hungry basically every " +
    "single day, way more than usual. Part of me is thinking about cutting my portions down " +
    "since the hunger seems to be working against my goal, but another part of me knows that " +
    "probably isn't a great idea given how much I'm running. Not sure what to do here.";
  const result = runSafetyScreen(text);
  assert.equal(result.flagged, false);
});

test("true-positive wording: crisis_language stays meaningfully protective, not just an apology", () => {
  const result = runSafetyScreen("There's no point in any of this anymore, I don't want to be here anymore.");
  assert.ok(result.categories.includes("crisis_language"));
  const message = result.pathwayMessage!;
  assert.ok(message.includes("988"), "must still surface the crisis line");
  assert.ok(message.toLowerCase().includes("crisis"));
  assert.ok(
    !/^\s*(sorry|i may have misunderstood|i might be wrong|i could be wrong)/i.test(message),
    "must not lead with an apology/hedge ahead of the protective content"
  );
});

test("true-positive wording: disordered_eating stays meaningfully protective, not just an apology", () => {
  const result = runSafetyScreen("I binged pretty badly and I don't deserve to eat much this week because of it.");
  assert.ok(result.categories.includes("disordered_eating"));
  const message = result.pathwayMessage!.toLowerCase();
  assert.ok(message.includes("doctor") || message.includes("therapist"), "must still point toward real help");
  assert.ok(
    !/^\s*(sorry|i may have misunderstood|i might be wrong|i could be wrong)/i.test(result.pathwayMessage!),
    "must not lead with an apology/hedge ahead of the protective content"
  );
});

// --- Integration: rapid-weight-change (closes the Package 6 gap) ---

let server: Server;
let baseUrl: string;

const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
const userA = { authProviderId: `test-safety8-a-${suffix}`, email: `safety8-a-${suffix}@test.local` };
const createdUserIds: string[] = [];
let userAId: string;

before(async () => {
  const app = await createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  const inserted = await db
    .insert(users)
    .values({
      email: userA.email,
      authProvider: "replit",
      authProviderId: userA.authProviderId,
      consentVersion: CURRENT_CONSENT_VERSION,
      consentAcceptedAt: new Date(),
    })
    .returning();
  createdUserIds.push(inserted[0].id);
  userAId = inserted[0].id;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id));
  }
});

function extractCookie(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  assert.ok(setCookie, "expected a Set-Cookie header from login");
  return setCookie!.split(";")[0];
}

async function loginAs(user: { authProviderId: string; email: string }): Promise<string> {
  const res = await fetch(`${baseUrl}/api/_test/login-as`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(user),
  });
  assert.equal(res.status, 200, "test login route should succeed");
  return extractCookie(res);
}

async function seedParticipantProfile(userId: string, startingWeightValue: string) {
  const [row] = await db
    .insert(participantProfiles)
    .values({
      userId,
      version: 1,
      startingWeightValue,
      startingWeightUnit: "lb",
      startingWeightDate: "2026-05-01",
      goals: [{ type: "weight-loss", description: "test goal" }],
    })
    .returning();
  return row;
}

async function seedWeightObservation(userId: string, value: string, observedDate: string) {
  const [row] = await db
    .insert(observations)
    .values({
      userId,
      type: "weight",
      observedDate,
      value,
      unit: "lb",
      confidenceLevel: "measured",
      verificationState: "proposed",
    })
    .returning();
  return row;
}

interface ProcessResponse {
  status: string;
  pathwayMessage?: string;
  observations?: unknown[];
}

test("rapid weight change short-circuits exactly like the text-based categories", async () => {
  const cookie = await loginAs(userA);
  await seedParticipantProfile(userAId, "200.0");
  await seedWeightObservation(userAId, "195.0", "2026-07-01");

  // 195 -> 180 is a 15 lb drop, 7.5% of the 200 lb starting weight —
  // well above the 2% threshold.
  const createRes = await fetch(`${baseUrl}/api/inbox/text`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ text: "Weighed in at 180 lbs this morning." }),
  });
  assert.equal(createRes.status, 201);
  const event = (await createRes.json()) as { id: string };

  const processRes = await fetch(`${baseUrl}/api/inbox/${event.id}/process`, {
    method: "POST",
    headers: { cookie },
  });
  assert.equal(processRes.status, 200);
  const result = (await processRes.json()) as ProcessResponse;

  assert.equal(result.status, "safety_flagged");
  assert.ok(result.pathwayMessage);
  assert.equal(result.observations, undefined, "a flagged entry must produce zero Observations");

  const safetyRows = await db.select().from(safetyEvents).where(eq(safetyEvents.sourceInboxEventId, event.id));
  assert.equal(safetyRows.length, 1);
  assert.equal(safetyRows[0].policyCategory, "rapid_weight_change");

  const obsRows = await db.select().from(observations).where(eq(observations.sourceInboxEventId, event.id));
  assert.equal(obsRows.length, 0, "no Observation row may exist for a flagged InboxEvent");
});

test("a normal weight entry within threshold processes normally", async () => {
  const cookie = await loginAs(userA);
  // Reuses the profile the prior test already seeded (version is unique
  // per user, so it isn't re-seeded here) — just adds a more recent prior
  // weight observation for this test's comparison.
  await seedWeightObservation(userAId, "180.0", "2026-07-05");

  // 180 -> 179 is a 1 lb drop, 0.5% of starting weight — well under 2%.
  const createRes = await fetch(`${baseUrl}/api/inbox/text`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ text: "Weighed in at 179 lbs this morning." }),
  });
  const event = (await createRes.json()) as { id: string };

  const processRes = await fetch(`${baseUrl}/api/inbox/${event.id}/process`, {
    method: "POST",
    headers: { cookie },
  });
  const result = (await processRes.json()) as ProcessResponse;

  assert.ok(result.status === "processed" || result.status === "needs_followup");
});
