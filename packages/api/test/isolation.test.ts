// General auth-pipeline proof: unauthenticated rejection and the consent
// gate. Route-specific cross-account isolation (e.g. for the
// ParticipantProfile routes) lives in its own test file next to the routes
// it covers — see test/participantProfile.test.ts, which is what Package 3
// added when it replaced Package 2's placeholder participantProfiles
// routes with the real onboarding/versioning implementation. Don't assume
// this file's coverage extends to routes it doesn't exercise; the pattern
// is "prove it again" per route surface, not "prove it once."
//
// Sessions here are established via POST /api/_test/login-as — a
// test-only route (routes/testAuth.ts, only mounted when
// NODE_ENV === "test") that calls req.login() exactly the way the real
// OIDC callback does. A real browser-driven Replit OIDC login can't be
// automated in CI, which is why this shortcut exists — see
// packages/api/README.md for what that means for "definition of done."
import * as dotenv from "dotenv";
dotenv.config();
process.env.NODE_ENV = "test";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { db, users } from "../src/db";
import { CURRENT_CONSENT_VERSION } from "../src/consent";

let server: Server;
let baseUrl: string;

const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
const createdUserIds: string[] = [];

before(async () => {
  const app = await createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
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

const validProfilePayload = {
  dateOfBirth: "1990-01-01",
  startingWeight: { value: 180, unit: "lb", date: "2026-08-01" },
  goals: [{ type: "weight-loss", description: "test goal" }],
  onWeightManagementMedication: false,
};

test("unauthenticated request to a protected route is rejected", async () => {
  const res = await fetch(`${baseUrl}/api/participant-profiles/current`);
  assert.equal(res.status, 401);
});

test("consent gate blocks other routes until the current version is accepted", async () => {
  const freshUser = {
    authProviderId: `test-isolation-c-${suffix}`,
    email: `isolation-c-${suffix}@test.local`,
  };
  const cookie = await loginAs(freshUser);

  // Triggers ACC-01 first-login row creation; consent routes are exempt
  // from the consent gate itself.
  const consentInfoRes = await fetch(`${baseUrl}/api/consent`, { headers: { cookie } });
  assert.equal(consentInfoRes.status, 200);
  const info = (await consentInfoRes.json()) as { accepted: boolean };
  assert.equal(info.accepted, false);

  const blockedRes = await fetch(`${baseUrl}/api/participant-profiles`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(validProfilePayload),
  });
  assert.equal(blockedRes.status, 403, "unconsented user must be blocked from other routes");

  const acceptRes = await fetch(`${baseUrl}/api/consent/accept`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ version: CURRENT_CONSENT_VERSION }),
  });
  assert.equal(acceptRes.status, 200);

  const afterAcceptRes = await fetch(`${baseUrl}/api/participant-profiles`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(validProfilePayload),
  });
  assert.equal(afterAcceptRes.status, 201, "consented user should be able to proceed");

  const rows = await db.select().from(users).where(eq(users.authProviderId, freshUser.authProviderId));
  if (rows[0]) createdUserIds.push(rows[0].id);
});
