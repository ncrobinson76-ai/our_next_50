// The single most important test in this build so far: proves that one
// account can never read, modify, or delete another account's data, and
// that unauthenticated requests to protected routes are rejected outright.
//
// Two real users are created directly in the database. Each gets a real,
// server-established session via POST /api/_test/login-as — a test-only
// route (routes/testAuth.ts, only mounted when NODE_ENV === "test") that
// calls req.login() exactly the way the real OIDC callback does. That
// route is the only test-specific shortcut here: everything downstream of
// "there's a verified session" (resolveAppUser, requireConsent,
// attachScopedData, the participantProfiles routes) is the exact
// production code path. A real browser-driven Replit OIDC login can't be
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

const suffix = Date.now();
const userA = { authProviderId: `test-isolation-a-${suffix}`, email: `isolation-a-${suffix}@test.local` };
const userB = { authProviderId: `test-isolation-b-${suffix}`, email: `isolation-b-${suffix}@test.local` };

const createdUserIds: string[] = [];

before(async () => {
  const app = await createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  // Pre-accept consent for A and B so isolation assertions aren't
  // entangled with the consent gate (that's covered separately below).
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
  // Cascades to any participantProfiles rows these test users created.
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

const newProfilePayload = {
  version: 1,
  startingWeightValue: "180.00",
  startingWeightUnit: "lb",
  startingWeightDate: "2026-08-01",
  goals: [{ type: "weight-loss", description: "isolation test goal" }],
};

test("unauthenticated request to a protected route is rejected", async () => {
  const res = await fetch(
    `${baseUrl}/api/participant-profiles/00000000-0000-0000-0000-000000000000`
  );
  assert.equal(res.status, 401);
});

test("cross-account isolation: B cannot read, update, or delete A's profile", async () => {
  const cookieA = await loginAs(userA);
  const cookieB = await loginAs(userB);

  const createRes = await fetch(`${baseUrl}/api/participant-profiles`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: cookieA },
    body: JSON.stringify(newProfilePayload),
  });
  assert.equal(createRes.status, 201, "A should be able to create their own profile");
  const profile = (await createRes.json()) as { id: string; personalReason: string | null };
  assert.ok(profile.id);

  const ownReadRes = await fetch(`${baseUrl}/api/participant-profiles/${profile.id}`, {
    headers: { cookie: cookieA },
  });
  assert.equal(ownReadRes.status, 200, "A should be able to read their own profile");

  const crossReadRes = await fetch(`${baseUrl}/api/participant-profiles/${profile.id}`, {
    headers: { cookie: cookieB },
  });
  assert.equal(crossReadRes.status, 404, "B reading A's profile must fail");

  const crossUpdateRes = await fetch(`${baseUrl}/api/participant-profiles/${profile.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: cookieB },
    body: JSON.stringify({ personalReason: "hijacked by B" }),
  });
  assert.equal(crossUpdateRes.status, 404, "B updating A's profile must fail");

  const crossDeleteRes = await fetch(`${baseUrl}/api/participant-profiles/${profile.id}`, {
    method: "DELETE",
    headers: { cookie: cookieB },
  });
  assert.equal(crossDeleteRes.status, 404, "B deleting A's profile must fail");

  const stillThereRes = await fetch(`${baseUrl}/api/participant-profiles/${profile.id}`, {
    headers: { cookie: cookieA },
  });
  assert.equal(stillThereRes.status, 200, "A's profile must be untouched and still readable by A");
  const stillThere = (await stillThereRes.json()) as { personalReason: string | null };
  assert.equal(stillThere.personalReason, null, "B's update must not have applied");
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
    body: JSON.stringify(newProfilePayload),
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
    body: JSON.stringify(newProfilePayload),
  });
  assert.equal(afterAcceptRes.status, 201, "consented user should be able to proceed");

  const rows = await db.select().from(users).where(eq(users.authProviderId, freshUser.authProviderId));
  if (rows[0]) createdUserIds.push(rows[0].id);
});
