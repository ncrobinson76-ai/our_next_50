// Package 5: INB-07, the user acting on their own proposed Observations
// (confirm / correct / list). Observations are seeded directly via `db`
// rather than through the extraction pipeline — deterministic and doesn't
// burn a real LLM call just to get a row to confirm/correct against.
//
// Sessions are established via the same test-only POST /api/_test/login-as
// route used throughout this package's tests (see isolation.test.ts's
// header comment for why).
import * as dotenv from "dotenv";
dotenv.config();
process.env.NODE_ENV = "test";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { db, users, observations } from "../src/db";
import { CURRENT_CONSENT_VERSION } from "../src/consent";

let server: Server;
let baseUrl: string;

const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
const userA = { authProviderId: `test-obs-a-${suffix}`, email: `obs-a-${suffix}@test.local` };
const userB = { authProviderId: `test-obs-b-${suffix}`, email: `obs-b-${suffix}@test.local` };

const createdUserIds: string[] = [];
let userAId: string;
let userBId: string;

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
  userAId = createdUserIds[0];
  userBId = createdUserIds[1];
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

async function seedObservation(userId: string, value = "180.00") {
  const [row] = await db
    .insert(observations)
    .values({
      userId,
      type: "weight",
      observedDate: "2026-08-01",
      value,
      unit: "lb",
      confidenceLevel: "user_reported",
      verificationState: "proposed",
    })
    .returning();
  return row;
}

interface ObservationResponse {
  id: string;
  value: number | null;
  verificationState: string;
  isSuperseded: boolean;
  supersedesObservationId: string | null;
  correctionReason: string | null;
}

test("confirm sets verificationState to confirmed, no new row", async () => {
  const cookie = await loginAs(userA);
  const seeded = await seedObservation(userAId);

  const res = await fetch(`${baseUrl}/api/observations/${seeded.id}/confirm`, {
    method: "POST",
    headers: { cookie },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as ObservationResponse;
  assert.equal(body.id, seeded.id);
  assert.equal(body.verificationState, "confirmed");

  const rows = await db.select().from(observations).where(eq(observations.userId, userAId));
  assert.equal(rows.filter((r) => r.id === seeded.id).length, 1, "confirm must not create a new row");
});

test("correct creates a new row with a proper supersession chain", async () => {
  const cookie = await loginAs(userA);
  const seeded = await seedObservation(userAId, "181.00");

  const res = await fetch(`${baseUrl}/api/observations/${seeded.id}/correct`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ value: 179.5, correctionReason: "misread the scale" }),
  });
  assert.equal(res.status, 201);
  const corrected = (await res.json()) as ObservationResponse;

  assert.notEqual(corrected.id, seeded.id);
  assert.equal(corrected.value, 179.5);
  assert.equal(corrected.verificationState, "confirmed", "a user's own correction is authoritative");
  assert.equal(corrected.supersedesObservationId, seeded.id);
  assert.equal(corrected.correctionReason, "misread the scale");

  const oldRow = (await db.select().from(observations).where(eq(observations.id, seeded.id)))[0];
  assert.equal(oldRow.isSuperseded, true);
  assert.equal(Number(oldRow.value), 181, "the old row's value must be unchanged");

  const defaultListRes = await fetch(`${baseUrl}/api/observations`, { headers: { cookie } });
  const defaultList = (await defaultListRes.json()) as { observations: ObservationResponse[] };
  assert.ok(defaultList.observations.some((o) => o.id === corrected.id));
  assert.ok(!defaultList.observations.some((o) => o.id === seeded.id), "default list must exclude the superseded row");

  const fullListRes = await fetch(`${baseUrl}/api/observations?includeSuperseded=true`, { headers: { cookie } });
  const fullList = (await fullListRes.json()) as { observations: ObservationResponse[] };
  assert.ok(fullList.observations.some((o) => o.id === corrected.id));
  assert.ok(fullList.observations.some((o) => o.id === seeded.id), "includeSuperseded=true must include the old row");
});

test("correcting an already-superseded row is rejected", async () => {
  const cookie = await loginAs(userA);
  const seeded = await seedObservation(userAId, "150.00");

  const firstCorrect = await fetch(`${baseUrl}/api/observations/${seeded.id}/correct`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ value: 149 }),
  });
  assert.equal(firstCorrect.status, 201);

  const secondCorrect = await fetch(`${baseUrl}/api/observations/${seeded.id}/correct`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ value: 148 }),
  });
  assert.equal(secondCorrect.status, 409, "correcting an already-superseded row must fail");
});

test("cross-account isolation: B cannot confirm, correct, or list A's observations", async () => {
  const cookieB = await loginAs(userB);
  const seeded = await seedObservation(userAId, "200.00");

  const crossConfirmRes = await fetch(`${baseUrl}/api/observations/${seeded.id}/confirm`, {
    method: "POST",
    headers: { cookie: cookieB },
  });
  assert.equal(crossConfirmRes.status, 404, "B confirming A's observation must fail");

  const crossCorrectRes = await fetch(`${baseUrl}/api/observations/${seeded.id}/correct`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: cookieB },
    body: JSON.stringify({ value: 1 }),
  });
  assert.equal(crossCorrectRes.status, 404, "B correcting A's observation must fail");

  const bListRes = await fetch(`${baseUrl}/api/observations`, { headers: { cookie: cookieB } });
  const bList = (await bListRes.json()) as { observations: ObservationResponse[] };
  assert.ok(!bList.observations.some((o) => o.id === seeded.id), "B's list must never include A's observation");

  // A's row is untouched by B's failed attempts.
  const stillThere = (await db.select().from(observations).where(eq(observations.id, seeded.id)))[0];
  assert.equal(stillThere.isSuperseded, false);
  assert.equal(stillThere.verificationState, "proposed");
});
