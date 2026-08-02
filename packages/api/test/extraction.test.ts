// Package 5: the extraction pipeline. PRD Section 9's ordering is the
// core property under test — safety screening runs first, per entry, and
// a flagged entry never reaches extraction at all.
//
// Sessions are established via the same test-only POST /api/_test/login-as
// route used throughout this package's tests (see isolation.test.ts's
// header comment for why). These tests make real Anthropic API calls for
// the non-flagged cases (same as packages/eval-harness) — the safety-flag
// tests do not, since they short-circuit before any LLM call.
import * as dotenv from "dotenv";
dotenv.config();
process.env.NODE_ENV = "test";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { db, users, safetyEvents, observations } from "../src/db";
import { CURRENT_CONSENT_VERSION } from "../src/consent";
import { extractObservations } from "../src/inbox/extraction";

let server: Server;
let baseUrl: string;

const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
const userA = { authProviderId: `test-extract-a-${suffix}`, email: `extract-a-${suffix}@test.local` };
const userB = { authProviderId: `test-extract-b-${suffix}`, email: `extract-b-${suffix}@test.local` };

const createdUserIds: string[] = [];

before(async () => {
  const app = await createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  for (const u of [userA, userB]) {
    const inserted = await db
      .insert(users)
      .values({
        email: u.email,
        authProvider: "replit",
        authProviderId: u.authProviderId,
        consentVersion: CURRENT_CONSENT_VERSION,
        consentAcceptedAt: new Date(),
      })
      .returning();
    createdUserIds.push(inserted[0].id);
  }
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

interface InboxEventResponse {
  id: string;
  status: string;
}

interface ProcessResponse {
  status: string;
  pathwayMessage?: string;
  followUpQuestion?: string;
  observations?: Array<{
    type: string;
    confidenceLevel: string;
    verificationState: string;
    sourceInboxEventId: string;
    value: number | null;
    isExplicitNonEvent: boolean;
  }>;
  inboxEvent: InboxEventResponse;
}

async function submitText(cookie: string, text: string): Promise<InboxEventResponse> {
  const res = await fetch(`${baseUrl}/api/inbox/text`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ text }),
  });
  assert.equal(res.status, 201);
  return (await res.json()) as InboxEventResponse;
}

test("a safety-flagged entry produces a SafetyEvent, safety_flagged status, and zero Observations", async () => {
  const cookie = await loginAs(userA);
  const event = await submitText(cookie, "I've been thinking there's no point in any of this anymore.");

  const processRes = await fetch(`${baseUrl}/api/inbox/${event.id}/process`, {
    method: "POST",
    headers: { cookie },
  });
  assert.equal(processRes.status, 200);
  const result = (await processRes.json()) as ProcessResponse;

  assert.equal(result.status, "safety_flagged");
  assert.ok(result.pathwayMessage);
  assert.equal(result.inboxEvent.status, "safety_flagged");
  assert.equal(result.observations, undefined, "a flagged entry must produce zero Observations");

  const safetyRows = await db
    .select()
    .from(safetyEvents)
    .where(eq(safetyEvents.sourceInboxEventId, event.id));
  assert.equal(safetyRows.length, 1);
  assert.equal(safetyRows[0].policyCategory, "crisis_language");

  const obsRows = await db
    .select()
    .from(observations)
    .where(eq(observations.sourceInboxEventId, event.id));
  assert.equal(obsRows.length, 0, "no Observation row may exist for a flagged InboxEvent");
});

test("a normal entry produces correctly typed, correctly confidence-tagged Observations", async () => {
  const cookie = await loginAs(userA);
  const event = await submitText(
    cookie,
    "Weighed in at 172.4 lbs this morning. Felt pretty hungry around 3pm. Went for a 20 minute walk after dinner."
  );

  const processRes = await fetch(`${baseUrl}/api/inbox/${event.id}/process`, {
    method: "POST",
    headers: { cookie },
  });
  assert.equal(processRes.status, 200);
  const result = (await processRes.json()) as ProcessResponse;

  assert.ok(result.status === "processed" || result.status === "needs_followup");
  if (result.status === "needs_followup") {
    assert.ok(result.followUpQuestion);
    return; // a reasonable model choice for this text; the pipeline behaved correctly either way
  }

  assert.ok(result.observations && result.observations.length > 0, "expected at least one extracted Observation");
  for (const obs of result.observations!) {
    assert.equal(obs.verificationState, "proposed", "nothing auto-confirms");
    assert.equal(obs.sourceInboxEventId, event.id);
  }

  const weightObs = result.observations!.find((o) => o.type === "weight");
  assert.ok(weightObs, "expected a weight observation from a precisely stated figure");
  assert.equal(weightObs!.confidenceLevel, "measured", '"172.4 lbs" is a precise stated figure');
  assert.ok(Math.abs((weightObs!.value ?? 0) - 172.4) < 0.01);
});

test("unauthenticated request to process/follow-up-answer routes is rejected", async () => {
  const processRes = await fetch(`${baseUrl}/api/inbox/00000000-0000-0000-0000-000000000000/process`, {
    method: "POST",
  });
  assert.equal(processRes.status, 401);

  const followUpRes = await fetch(`${baseUrl}/api/inbox/00000000-0000-0000-0000-000000000000/follow-up-answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answer: "yesterday" }),
  });
  assert.equal(followUpRes.status, 401);
});

test("cross-account isolation: B cannot process or answer follow-up on A's InboxEvent", async () => {
  const cookieA = await loginAs(userA);
  const cookieB = await loginAs(userB);

  const event = await submitText(cookieA, "Slept about 6 hours, nothing unusual today.");

  const crossProcessRes = await fetch(`${baseUrl}/api/inbox/${event.id}/process`, {
    method: "POST",
    headers: { cookie: cookieB },
  });
  assert.equal(crossProcessRes.status, 404, "B processing A's InboxEvent must fail");

  const crossFollowUpRes = await fetch(`${baseUrl}/api/inbox/${event.id}/follow-up-answer`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: cookieB },
    body: JSON.stringify({ answer: "today" }),
  });
  assert.equal(crossFollowUpRes.status, 404, "B answering a follow-up on A's InboxEvent must fail");

  // A can still process their own event normally afterward.
  const ownProcessRes = await fetch(`${baseUrl}/api/inbox/${event.id}/process`, {
    method: "POST",
    headers: { cookie: cookieA },
  });
  assert.equal(ownProcessRes.status, 200);
});

test("extraction never proposes more than one follow-up, even across a second pass", async () => {
  const referenceDate = "2026-08-01";
  const ambiguousText =
    "Weighed in earlier but not sure that's right, felt some pain but not sure how bad, and slept weird last night.";

  const firstPass = await extractObservations(ambiguousText, referenceDate);
  assert.ok(
    firstPass.followUpQuestion === null || typeof firstPass.followUpQuestion === "string",
    "followUpQuestion must be a single string or null, never a list"
  );

  // The second/final pass is not allowed to propose another follow-up
  // regardless of what the model itself returns — enforced in
  // extraction.ts, not left to the prompt alone.
  const secondPass = await extractObservations(ambiguousText, referenceDate, "It was moderate pain, and I slept around 5 hours.");
  assert.equal(secondPass.followUpQuestion, null, "a second/final extraction pass must never ask another follow-up");
});
