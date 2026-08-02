// Package 4: text/form inbox ingestion (INB-01). The single most important
// property under test here is structural symmetry — text and form must
// produce identical top-level InboxEvent shapes, differing only in what's
// inside `payload`. If that ever diverges, Package 5's processor (and
// Package 6's voice channel) can no longer treat all channels identically,
// which is exactly the bug this package exists to prevent.
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
const userA = { authProviderId: `test-inbox-a-${suffix}`, email: `inbox-a-${suffix}@test.local` };
const userB = { authProviderId: `test-inbox-b-${suffix}`, email: `inbox-b-${suffix}@test.local` };

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
  channel: string;
  status: string;
  payload: Record<string, unknown>;
  receivedAt: string;
  processedAt: string | null;
  createdAt: string;
}

test("text submission creates a text-channel event with the correct payload", async () => {
  const cookie = await loginAs(userA);
  const res = await fetch(`${baseUrl}/api/inbox/text`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ text: "walked 20 min, felt good, slept badly last night" }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as InboxEventResponse;
  assert.equal(body.channel, "text");
  assert.equal(body.status, "received");
  assert.equal(body.payload.text, "walked 20 min, felt good, slept badly last night");
  assert.ok(body.id);
  assert.ok(body.createdAt);
});

test("form submission creates a form-channel event with the correct payload", async () => {
  const cookie = await loginAs(userA);
  const res = await fetch(`${baseUrl}/api/inbox/form`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ weight: { value: 181.4, unit: "lb" }, hungerLevel: 3, note: "quick check-in" }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as InboxEventResponse;
  assert.equal(body.channel, "form");
  assert.equal(body.status, "received");
  assert.deepEqual(body.payload.weight, { value: 181.4, unit: "lb" });
  assert.equal(body.payload.hungerLevel, 3);
  assert.equal(body.payload.note, "quick check-in");
});

test("structural symmetry: text and form events share the exact same top-level field set", async () => {
  const cookie = await loginAs(userA);

  const textRes = await fetch(`${baseUrl}/api/inbox/text`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ text: "structural symmetry check" }),
  });
  const formRes = await fetch(`${baseUrl}/api/inbox/form`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ hungerLevel: 2 }),
  });
  assert.equal(textRes.status, 201);
  assert.equal(formRes.status, 201);

  const textEvent = (await textRes.json()) as InboxEventResponse;
  const formEvent = (await formRes.json()) as InboxEventResponse;

  const textKeys = Object.keys(textEvent).sort();
  const formKeys = Object.keys(formEvent).sort();
  assert.deepEqual(
    textKeys,
    formKeys,
    "text and form InboxEvent responses must have identical top-level field sets"
  );

  // Only payload's *content* should differ in shape — everything else
  // about the two events is structurally identical.
  const { payload: _textPayload, channel: _textChannel, ...textRest } = textEvent;
  const { payload: _formPayload, channel: _formChannel, ...formRest } = formEvent;
  assert.deepEqual(Object.keys(textRest).sort(), Object.keys(formRest).sort());
  assert.equal(textEvent.status, formEvent.status, "both must start in the same status");
});

test("text: empty submission is rejected", async () => {
  const cookie = await loginAs(userA);
  const emptyRes = await fetch(`${baseUrl}/api/inbox/text`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ text: "" }),
  });
  assert.equal(emptyRes.status, 400);

  const missingRes = await fetch(`${baseUrl}/api/inbox/text`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({}),
  });
  assert.equal(missingRes.status, 400);
});

test("form: entirely empty submission is rejected", async () => {
  const cookie = await loginAs(userA);
  const res = await fetch(`${baseUrl}/api/inbox/form`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test("form: invalid hungerLevel is rejected", async () => {
  const cookie = await loginAs(userA);
  const res = await fetch(`${baseUrl}/api/inbox/form`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ hungerLevel: 9 }),
  });
  assert.equal(res.status, 400);
});

test("GET /api/inbox only returns the authenticated user's own events, most recent first", async () => {
  const cookieA = await loginAs(userA);
  const cookieB = await loginAs(userB);

  // B has created nothing yet in this test's scope; give B exactly one
  // event so we can prove A's (much larger) history never leaks into B's.
  const bCreateRes = await fetch(`${baseUrl}/api/inbox/text`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: cookieB },
    body: JSON.stringify({ text: "B's only event" }),
  });
  assert.equal(bCreateRes.status, 201);

  const bListRes = await fetch(`${baseUrl}/api/inbox`, { headers: { cookie: cookieB } });
  assert.equal(bListRes.status, 200);
  const bList = (await bListRes.json()) as { events: InboxEventResponse[]; total: number };
  assert.equal(bList.total, 1, "B must only see B's own events, never A's");
  assert.equal(bList.events[0].payload.text, "B's only event");

  const aListRes = await fetch(`${baseUrl}/api/inbox`, { headers: { cookie: cookieA } });
  const aList = (await aListRes.json()) as { events: InboxEventResponse[]; total: number };
  assert.ok(aList.total >= 3, "A should see at least the 3 events created earlier in this file");
  assert.ok(
    aList.events.every((e) => e.payload.text !== "B's only event"),
    "A's list must never include B's event"
  );

  // Most-recent-first ordering.
  const timestamps = aList.events.map((e) => new Date(e.receivedAt).getTime());
  const sorted = [...timestamps].sort((a, b) => b - a);
  assert.deepEqual(timestamps, sorted, "events must be ordered most recent first");
});

test("GET /api/inbox pagination: limit/offset", async () => {
  const cookie = await loginAs(userA);
  const page1Res = await fetch(`${baseUrl}/api/inbox?limit=2&offset=0`, { headers: { cookie } });
  const page1 = (await page1Res.json()) as { events: InboxEventResponse[]; total: number; limit: number };
  assert.equal(page1.events.length, 2);
  assert.equal(page1.limit, 2);

  const page2Res = await fetch(`${baseUrl}/api/inbox?limit=2&offset=2`, { headers: { cookie } });
  const page2 = (await page2Res.json()) as { events: InboxEventResponse[] };
  const page1Ids = new Set(page1.events.map((e) => e.id));
  assert.ok(page2.events.every((e) => !page1Ids.has(e.id)), "pages must not overlap");
});
