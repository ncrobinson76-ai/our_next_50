// Package 7: the Timeline read/query layer over Observations already
// written by Package 5's pipeline and corrected via the existing
// PATCH /api/observations/:id/correct (INB-07) — no new write logic here,
// so these tests seed data directly via `db` rather than running it
// through extraction. That's a deliberate choice: this package's own
// logic is the grouping/join/response-shape work, not extraction quality,
// so there's no reason to depend on LLM output (or spend real API calls)
// to test it.
//
// The single most important test below is the side-by-side one: PRD
// Section 8.4 requires a normal observation, an explicit non-event, and
// "no entry at all" to be genuinely distinguishable from one API
// response — asserted together, not as three tests that could each pass
// while the actual distinction is broken.
import * as dotenv from "dotenv";
dotenv.config();
process.env.NODE_ENV = "test";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { db, users, observations, inboxEvents } from "../src/db";
import { CURRENT_CONSENT_VERSION } from "../src/consent";

let server: Server;
let baseUrl: string;

const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
const userA = { authProviderId: `test-timeline-a-${suffix}`, email: `timeline-a-${suffix}@test.local` };
const userB = { authProviderId: `test-timeline-b-${suffix}`, email: `timeline-b-${suffix}@test.local` };

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

type ObservationOverrides = Partial<typeof observations.$inferInsert>;

async function seedObservation(userId: string, overrides: ObservationOverrides = {}) {
  const [row] = await db
    .insert(observations)
    .values({
      userId,
      type: "activity",
      observedDate: "2026-07-01",
      confidenceLevel: "user_reported",
      verificationState: "proposed",
      isExplicitNonEvent: false,
      ...overrides,
    })
    .returning();
  return row;
}

async function seedInboxEvent(userId: string, channel: "text" | "form" | "voice") {
  const [row] = await db
    .insert(inboxEvents)
    .values({ userId, channel, status: "processed" })
    .returning();
  return row;
}

interface TimelineDayResponse {
  date: string;
  hasExplicitNonEvent: boolean;
  observations: Array<{
    id: string;
    isExplicitNonEvent: boolean;
    channel: string | null;
    isCorrection: boolean;
    supersedesObservationId: string | null;
    isSuperseded: boolean;
  }>;
}

interface TimelineRangeResponse {
  from: string;
  to: string;
  days: TimelineDayResponse[];
}

test("unauthenticated request to timeline routes is rejected", async () => {
  const rangeRes = await fetch(`${baseUrl}/api/timeline`);
  assert.equal(rangeRes.status, 401);
  const dayRes = await fetch(`${baseUrl}/api/timeline/2026-08-01`);
  assert.equal(dayRes.status, 401);
});

test(
  "a normal observation, an explicit non-event, and a no-entry day are all distinguishable in one response",
  async () => {
    const cookie = await loginAs(userA);
    const normalDate = "2026-07-10";
    const nonEventDate = "2026-07-11";
    const emptyDate = "2026-07-12";

    await seedObservation(userAId, {
      observedDate: normalDate,
      type: "weight",
      value: "180.0",
      unit: "lb",
      isExplicitNonEvent: false,
    });
    await seedObservation(userAId, {
      observedDate: nonEventDate,
      type: "activity",
      textValue: "didn't work out today",
      isExplicitNonEvent: true,
    });
    // emptyDate: nothing seeded — this is the "no entry" case.

    const res = await fetch(`${baseUrl}/api/timeline?from=${normalDate}&to=${emptyDate}`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as TimelineRangeResponse;

    const normalDay = body.days.find((d) => d.date === normalDate)!;
    const nonEventDay = body.days.find((d) => d.date === nonEventDate)!;
    const emptyDay = body.days.find((d) => d.date === emptyDate)!;
    assert.ok(normalDay && nonEventDay && emptyDay, "every date in range must have an entry, including the empty one");

    // Normal: one observation, not flagged as a non-event, day not flagged either.
    assert.equal(normalDay.hasExplicitNonEvent, false);
    assert.equal(normalDay.observations.length, 1);
    assert.equal(normalDay.observations[0].isExplicitNonEvent, false);

    // Explicit non-event: one observation, flagged both on the row and the day.
    assert.equal(nonEventDay.hasExplicitNonEvent, true);
    assert.equal(nonEventDay.observations.length, 1);
    assert.equal(nonEventDay.observations[0].isExplicitNonEvent, true);

    // No entry: present in the response, zero observations, not flagged.
    assert.equal(emptyDay.hasExplicitNonEvent, false);
    assert.equal(emptyDay.observations.length, 0);

    // All three genuinely distinct from each other, not just individually plausible.
    assert.notDeepEqual(normalDay, nonEventDay);
    assert.notDeepEqual(nonEventDay, emptyDay);
    assert.notDeepEqual(normalDay, emptyDay);
  }
);

test("provenance: channel is correctly populated for observations from each source", async () => {
  const cookie = await loginAs(userA);
  const date = "2026-07-15";

  const textEvent = await seedInboxEvent(userAId, "text");
  const formEvent = await seedInboxEvent(userAId, "form");
  const voiceEvent = await seedInboxEvent(userAId, "voice");

  const textObs = await seedObservation(userAId, { observedDate: date, sourceInboxEventId: textEvent.id });
  const formObs = await seedObservation(userAId, { observedDate: date, sourceInboxEventId: formEvent.id });
  const voiceObs = await seedObservation(userAId, { observedDate: date, sourceInboxEventId: voiceEvent.id });
  const manualObs = await seedObservation(userAId, { observedDate: date, sourceInboxEventId: null });

  const res = await fetch(`${baseUrl}/api/timeline/${date}`, { headers: { cookie } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as TimelineDayResponse;
  const byId = new Map(body.observations.map((o) => [o.id, o]));

  assert.equal(byId.get(textObs.id)?.channel, "text");
  assert.equal(byId.get(formObs.id)?.channel, "form");
  assert.equal(byId.get(voiceObs.id)?.channel, "voice");
  assert.equal(byId.get(manualObs.id)?.channel, null);
});

test("provenance: correction lineage and superseded filtering", async () => {
  const cookie = await loginAs(userA);
  const date = "2026-07-16";

  const original = await seedObservation(userAId, { observedDate: date, value: "180.0" });
  const corrected = await seedObservation(userAId, {
    observedDate: date,
    value: "179.0",
    verificationState: "confirmed",
    supersedesObservationId: original.id,
  });
  await db.update(observations).set({ isSuperseded: true }).where(eq(observations.id, original.id));

  const defaultRes = await fetch(`${baseUrl}/api/timeline/${date}`, { headers: { cookie } });
  const defaultBody = (await defaultRes.json()) as TimelineDayResponse;
  assert.equal(defaultBody.observations.length, 1, "default view excludes the superseded original");
  assert.equal(defaultBody.observations[0].id, corrected.id);
  assert.equal(defaultBody.observations[0].isCorrection, true);
  assert.equal(defaultBody.observations[0].supersedesObservationId, original.id);

  const fullRes = await fetch(`${baseUrl}/api/timeline/${date}?includeSuperseded=true`, { headers: { cookie } });
  const fullBody = (await fullRes.json()) as TimelineDayResponse;
  assert.equal(fullBody.observations.length, 2);
  const originalInFull = fullBody.observations.find((o) => o.id === original.id);
  assert.ok(originalInFull);
  assert.equal(originalInFull!.isCorrection, false);
  assert.equal(originalInFull!.isSuperseded, true);
});

test("date-range filtering is inclusive at both boundaries", async () => {
  const cookie = await loginAs(userA);
  const from = "2026-07-20";
  const middle = "2026-07-21";
  const to = "2026-07-22";
  const before = "2026-07-19";
  const after = "2026-07-23";

  await seedObservation(userAId, { observedDate: before });
  await seedObservation(userAId, { observedDate: from });
  await seedObservation(userAId, { observedDate: to });
  await seedObservation(userAId, { observedDate: after });

  const res = await fetch(`${baseUrl}/api/timeline?from=${from}&to=${to}`, { headers: { cookie } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as TimelineRangeResponse;

  assert.equal(body.days.length, 3, "from, middle, and to — exactly the requested range");
  assert.deepEqual(
    body.days.map((d) => d.date),
    [from, middle, to]
  );
  assert.equal(body.days.find((d) => d.date === from)!.observations.length, 1);
  assert.equal(body.days.find((d) => d.date === middle)!.observations.length, 0);
  assert.equal(body.days.find((d) => d.date === to)!.observations.length, 1);
});

test("default range is the last 30 days", async () => {
  const cookie = await loginAs(userA);
  const res = await fetch(`${baseUrl}/api/timeline`, { headers: { cookie } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as TimelineRangeResponse;
  assert.equal(body.days.length, 30);
});

test("invalid date inputs are rejected", async () => {
  const cookie = await loginAs(userA);

  const badRangeRes = await fetch(`${baseUrl}/api/timeline?from=not-a-date&to=2026-08-01`, { headers: { cookie } });
  assert.equal(badRangeRes.status, 400);

  const invertedRes = await fetch(`${baseUrl}/api/timeline?from=2026-08-10&to=2026-08-01`, { headers: { cookie } });
  assert.equal(invertedRes.status, 400);

  const badDayRes = await fetch(`${baseUrl}/api/timeline/08-01-2026`, { headers: { cookie } });
  assert.equal(badDayRes.status, 400);
});

test("cross-account isolation: B sees no trace of A's timeline data", async () => {
  const cookieB = await loginAs(userB);
  const date = "2026-07-25";
  await seedObservation(userAId, { observedDate: date, type: "weight", value: "150.0" });

  const rangeRes = await fetch(`${baseUrl}/api/timeline?from=${date}&to=${date}`, { headers: { cookie: cookieB } });
  const rangeBody = (await rangeRes.json()) as TimelineRangeResponse;
  assert.equal(rangeBody.days[0].observations.length, 0);
  assert.equal(rangeBody.days[0].hasExplicitNonEvent, false);

  const dayRes = await fetch(`${baseUrl}/api/timeline/${date}`, { headers: { cookie: cookieB } });
  const dayBody = (await dayRes.json()) as TimelineDayResponse;
  assert.equal(dayBody.observations.length, 0);
});
