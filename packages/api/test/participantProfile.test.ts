// Package 3: the ParticipantProfile onboarding/versioning routes. Covers
// what the package's definition of done asks for directly — create, fetch
// own, edit-creates-a-new-version-while-the-old-one-remains-queryable —
// plus a from-scratch cross-account isolation proof for this specific
// route surface (Package 2's isolation.test.ts coverage of the old
// placeholder routes doesn't carry over automatically; this is that proof,
// as this package's instructions asked for explicitly).
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
import { db, users } from "../src/db";
import { CURRENT_CONSENT_VERSION } from "../src/consent";

let server: Server;
let baseUrl: string;

const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
const userA = { authProviderId: `test-profile-a-${suffix}`, email: `profile-a-${suffix}@test.local` };
const userB = { authProviderId: `test-profile-b-${suffix}`, email: `profile-b-${suffix}@test.local` };

const createdUserIds: string[] = [];

before(async () => {
  const app = await createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  // Pre-accept consent so these tests aren't entangled with the consent
  // gate (that's isolation.test.ts's job).
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

const basePayload = {
  dateOfBirth: "1990-06-15",
  height: { value: 66, unit: "in" },
  startingWeight: { value: 182.4, unit: "lb", date: "2026-08-01" },
  goals: [{ type: "weight-loss", description: "steady progress", targetWeight: { value: 165, unit: "lb" } }],
  personalReason: "want more energy for my kids",
  typicalEatingPattern: "three meals, no snacking",
  typicalSleepPattern: "usually 7 hours",
  typicalActivityPattern: "walks a few times a week",
  exercisePreferences: ["walking", "swimming"],
  physicalLimitations: ["knee pain on stairs"],
  healthContext: "no major relevant conditions",
  onWeightManagementMedication: false,
};

interface ProfileResponse {
  id: string;
  version: number;
  personalReason: string | null;
  onWeightManagementMedication: boolean;
}

test("create: only Section 8.2 fields, unknown fields silently dropped", async () => {
  const cookie = await loginAs(userA);

  const res = await fetch(`${baseUrl}/api/participant-profiles`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ ...basePayload, labResults: { a1c: 5.4 }, photoUrl: "https://example.com/x.jpg" }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.version, 1);
  assert.equal(body.labResults, undefined, "out-of-scope field must not be persisted or echoed back");
  assert.equal(body.photoUrl, undefined, "out-of-scope field must not be persisted or echoed back");
});

test("create: rejects a second profile for the same user", async () => {
  const cookie = await loginAs(userA);
  const res = await fetch(`${baseUrl}/api/participant-profiles`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(basePayload),
  });
  assert.equal(res.status, 409, "A already has a profile from the previous test");
});

test("create: rejects incomplete input rather than defaulting silently", async () => {
  const cookie = await loginAs(userB);
  const { onWeightManagementMedication, ...withoutMedFlag } = basePayload;
  const res = await fetch(`${baseUrl}/api/participant-profiles`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(withoutMedFlag),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { errors: string[] };
  assert.ok(body.errors.some((e) => e.includes("onWeightManagementMedication")));
});

test("fetch own: GET current returns what was created", async () => {
  const cookie = await loginAs(userB);
  const createRes = await fetch(`${baseUrl}/api/participant-profiles`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(basePayload),
  });
  assert.equal(createRes.status, 201);

  const currentRes = await fetch(`${baseUrl}/api/participant-profiles/current`, { headers: { cookie } });
  assert.equal(currentRes.status, 200);
  const current = (await currentRes.json()) as ProfileResponse;
  assert.equal(current.version, 1);
  assert.equal(current.personalReason, basePayload.personalReason);
});

test("edit creates a new version; the old version remains queryable and unchanged", async () => {
  const cookie = await loginAs(userA);

  const beforeEditRes = await fetch(`${baseUrl}/api/participant-profiles/current`, { headers: { cookie } });
  const before = (await beforeEditRes.json()) as ProfileResponse;
  assert.equal(before.version, 1);
  const v1Id = before.id;

  const editRes = await fetch(`${baseUrl}/api/participant-profiles/current`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ personalReason: "updated reason", onWeightManagementMedication: true }),
  });
  assert.equal(editRes.status, 200);
  const edited = (await editRes.json()) as ProfileResponse;
  assert.equal(edited.version, 2, "edit must create version 2, not mutate version 1");
  assert.notEqual(edited.id, v1Id, "edit must be a new row");
  assert.equal(edited.personalReason, "updated reason");
  assert.equal(edited.onWeightManagementMedication, true);

  // The old version is untouched and still fetchable by its own id.
  const oldRes = await fetch(`${baseUrl}/api/participant-profiles/${v1Id}`, { headers: { cookie } });
  assert.equal(oldRes.status, 200);
  const old = (await oldRes.json()) as ProfileResponse;
  assert.equal(old.version, 1);
  assert.equal(old.personalReason, basePayload.personalReason, "old version's data must be unchanged");
  assert.equal(old.onWeightManagementMedication, false);

  // Both versions show up in the version history, in order.
  const versionsRes = await fetch(`${baseUrl}/api/participant-profiles/versions`, { headers: { cookie } });
  const versions = (await versionsRes.json()) as ProfileResponse[];
  assert.deepEqual(versions.map((v) => v.version).sort(), [1, 2]);

  // GET current now returns the new version.
  const currentRes = await fetch(`${baseUrl}/api/participant-profiles/current`, { headers: { cookie } });
  const current = (await currentRes.json()) as ProfileResponse;
  assert.equal(current.version, 2);
});

test("cross-account isolation: B cannot read A's profile by id", async () => {
  const cookieA = await loginAs(userA);
  const cookieB = await loginAs(userB);

  const currentRes = await fetch(`${baseUrl}/api/participant-profiles/current`, { headers: { cookie: cookieA } });
  const current = (await currentRes.json()) as ProfileResponse;

  const crossReadRes = await fetch(`${baseUrl}/api/participant-profiles/${current.id}`, {
    headers: { cookie: cookieB },
  });
  assert.equal(crossReadRes.status, 404, "B reading A's profile by id must fail");
});

test("cross-account isolation: B's edit never touches A's profile", async () => {
  const cookieA = await loginAs(userA);
  const cookieB = await loginAs(userB);

  const aBeforeRes = await fetch(`${baseUrl}/api/participant-profiles/current`, { headers: { cookie: cookieA } });
  const aBefore = (await aBeforeRes.json()) as ProfileResponse;

  // B edits — this can only ever affect B's own current profile, since
  // PATCH /current takes no id at all (see routes/participantProfiles.ts).
  const bEditRes = await fetch(`${baseUrl}/api/participant-profiles/current`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: cookieB },
    body: JSON.stringify({ personalReason: "B's own edit" }),
  });
  assert.equal(bEditRes.status, 200);
  const bEdited = (await bEditRes.json()) as ProfileResponse;
  assert.notEqual(bEdited.id, aBefore.id, "B's edit must produce a row distinct from A's");

  const aAfterRes = await fetch(`${baseUrl}/api/participant-profiles/current`, { headers: { cookie: cookieA } });
  const aAfter = (await aAfterRes.json()) as ProfileResponse;
  assert.equal(aAfter.id, aBefore.id, "A's current profile must be unaffected by B's edit");
  assert.equal(aAfter.version, aBefore.version, "A's version must not have advanced");
});
