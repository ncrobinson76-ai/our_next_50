// Package 9: the first time real user data reaches an LLM-generated weekly
// review. Two kinds of tests here, same split as test/safetyHardening.test.ts:
// pure unit tests against assembleEvidencePacket() (no server, no DB, no
// LLM — deterministic) for the confirmed/unconfirmed distinction, and real
// HTTP integration tests (real server, real DB, real Anthropic calls where
// synthesis actually runs) for the end-to-end pipeline. The weekly safety
// gate test is deterministic too — runSafetyCheck is a keyword/threshold
// matcher, not an LLM call, so it never reaches the model.
import * as dotenv from "dotenv";
dotenv.config();
process.env.NODE_ENV = "test";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { eq } from "drizzle-orm";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app";
import { db, users, observations, participantProfiles, programWeeks, weeklyReviews, safetyEvents } from "../src/db";
import { CURRENT_CONSENT_VERSION } from "../src/consent";
import { assembleEvidencePacket } from "../src/weeklyReview/evidencePacket";
import { WEEKLY_SAFETY_GATE_VERSION } from "../src/weeklyReview/service";
import type { ProgramWeekRow } from "../src/weeklyReview/programWeek";

type ProfileRow = InferSelectModel<typeof participantProfiles>;
type ObservationRow = InferSelectModel<typeof observations>;
type ObservationInsert = InferInsertModel<typeof observations>;
type ProfileInsert = InferInsertModel<typeof participantProfiles>;

// ---------------------------------------------------------------------
// Part 1: pure unit tests for assembleEvidencePacket's confirmed/proposed
// handling (PRD Section 8.4). No DB, no server, no LLM.
// ---------------------------------------------------------------------

let fakeIdCounter = 0;
function nextFakeId(prefix: string): string {
  fakeIdCounter++;
  return `${prefix}-${fakeIdCounter}`;
}

function fakeProgramWeek(overrides: Partial<ProgramWeekRow> = {}): ProgramWeekRow {
  return {
    id: nextFakeId("pw"),
    userId: "user-1",
    weekStartDate: "2026-01-01",
    weekEndDate: "2026-01-07",
    completedWeekNumber: null,
    evidenceSufficient: false,
    reflectionObservationId: null,
    status: "scheduled",
    createdAt: new Date(),
    ...overrides,
  };
}

function fakeProfile(overrides: Partial<ProfileRow> = {}): ProfileRow {
  return {
    id: nextFakeId("profile"),
    userId: "user-1",
    version: 1,
    dateOfBirth: null,
    ageRange: null,
    heightValue: null,
    heightUnit: null,
    startingWeightValue: "180.0",
    startingWeightUnit: "lb",
    startingWeightDate: "2026-01-01",
    waistValue: null,
    waistUnit: null,
    goals: [{ type: "weight-loss", description: "test goal" }],
    personalReason: null,
    typicalEatingPattern: null,
    typicalSleepPattern: null,
    typicalActivityPattern: null,
    exercisePreferences: null,
    physicalLimitations: null,
    healthContext: null,
    onWeightManagementMedication: false,
    createdAt: new Date(),
    ...overrides,
  };
}

function fakeObservation(overrides: Partial<ObservationRow> = {}): ObservationRow {
  return {
    id: nextFakeId("obs"),
    userId: "user-1",
    type: "weight",
    observedDate: "2026-01-02",
    timeOfDay: null,
    value: null,
    unit: null,
    textValue: null,
    structuredDetails: null,
    isExplicitNonEvent: false,
    confidenceLevel: "user_reported",
    verificationState: "confirmed",
    sourceInboxEventId: null,
    sourceTranscriptId: null,
    isSuperseded: false,
    supersedesObservationId: null,
    correctionReason: null,
    createdAt: new Date(),
    ...overrides,
  };
}

test("confirmed observations populate structured fields; unconfirmed ones never do, but surface hedged in freeTextNotes", () => {
  const programWeek = fakeProgramWeek();
  const profile = fakeProfile();

  const confirmedWeight = fakeObservation({
    type: "weight",
    observedDate: "2026-01-02",
    value: "180.0",
    unit: "lb",
    verificationState: "confirmed",
  });
  const unconfirmedWeight = fakeObservation({
    type: "weight",
    observedDate: "2026-01-03",
    value: "250.0",
    unit: "lb",
    verificationState: "proposed",
  });
  const unconfirmedMeal = fakeObservation({
    type: "meal",
    observedDate: "2026-01-03",
    textValue: "an enormous celebratory cake",
    verificationState: "proposed",
  });

  const { packet } = assembleEvidencePacket(programWeek, profile, "2026-01-01", [
    confirmedWeight,
    unconfirmedWeight,
    unconfirmedMeal,
  ]);

  const day2 = packet.observations.find((o) => o.date === "2026-01-02");
  assert.equal(day2?.weight?.value, 180, "a confirmed weight must populate the structured weight field");

  const day3 = packet.observations.find((o) => o.date === "2026-01-03");
  assert.equal(day3?.weight, undefined, "an unconfirmed weight must never populate the structured weight field");
  assert.equal(day3?.meals, undefined, "an unconfirmed meal must never populate the structured meals field");
  assert.ok(day3?.freeTextNotes?.includes("250"), "the unconfirmed weight value must still surface, not be silently dropped");
  assert.ok(
    day3?.freeTextNotes?.toLowerCase().includes("unconfirmed") || day3?.freeTextNotes?.toLowerCase().includes("not yet confirmed"),
    "unconfirmed data must be explicitly hedged in the packet text, never read as plain fact"
  );
  assert.ok(day3?.freeTextNotes?.includes("enormous celebratory cake"), "unconfirmed meal content must still surface as hedged text");

  // Derived metrics are objective computed facts in the prompt — they must
  // never be influenced by unconfirmed data.
  assert.equal(
    packet.derivedMetrics.weightTrend?.lastLogged.value,
    180,
    "weight trend must be computed from confirmed data only, ignoring the unconfirmed 250lb entry entirely"
  );
});

test("superseded observations are excluded from the packet entirely", () => {
  const programWeek = fakeProgramWeek();
  const profile = fakeProfile();
  const superseded = fakeObservation({
    type: "weight",
    observedDate: "2026-01-02",
    value: "999.0",
    unit: "lb",
    verificationState: "confirmed",
    isSuperseded: true,
  });

  const { packet, includedObservationIds } = assembleEvidencePacket(programWeek, profile, "2026-01-01", [superseded]);

  assert.equal(packet.observations.length, 0);
  assert.equal(includedObservationIds.length, 0);
});

// ---------------------------------------------------------------------
// Part 2: real HTTP integration tests — real server, real DB, real
// Anthropic calls wherever synthesis actually runs.
// ---------------------------------------------------------------------

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

async function createUser(label: string): Promise<{ id: string; cookie: string }> {
  const authProviderId = `test-pkg9-${label}-${suffix}`;
  const email = `pkg9-${label}-${suffix}@test.local`;

  const [row] = await db
    .insert(users)
    .values({
      email,
      authProvider: "replit",
      authProviderId,
      consentVersion: CURRENT_CONSENT_VERSION,
      consentAcceptedAt: new Date(),
    })
    .returning();
  createdUserIds.push(row.id);

  const res = await fetch(`${baseUrl}/api/_test/login-as`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ authProviderId, email }),
  });
  assert.equal(res.status, 200, "test login route should succeed");
  return { id: row.id, cookie: extractCookie(res) };
}

const today = new Date().toISOString().slice(0, 10);

function addDaysToToday(days: number): string {
  const d = new Date(`${today}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Anchors the user's program start (and so the "current" 7-day window) at today. */
async function seedProfile(userId: string, overrides: Partial<ProfileInsert> = {}): Promise<ProfileRow> {
  const [row] = await db
    .insert(participantProfiles)
    .values({
      userId,
      version: 1,
      startingWeightValue: "180.0",
      startingWeightUnit: "lb",
      startingWeightDate: today,
      goals: [{ type: "weight-loss", description: "Feel stronger and more energetic day to day." }],
      typicalEatingPattern: "Three meals a day, occasional snacking in the evening.",
      typicalActivityPattern: "Walks most days, strength trains twice a week.",
      onWeightManagementMedication: false,
      ...overrides,
    })
    .returning();
  return row;
}

async function seedObservation(userId: string, values: Omit<ObservationInsert, "id" | "createdAt" | "userId">): Promise<ObservationRow> {
  const [row] = await db
    .insert(observations)
    .values({ userId, ...values })
    .returning();
  return row;
}

interface GenerateReviewResponse {
  status: string;
  pathwayMessage?: string;
  review?: {
    id: string;
    structuredClaims: {
      recordedFacts: string[];
      observationsSummary: string[];
      tentativeHypotheses: string[];
      whatsWorking: string[];
      friction: string[];
      whatShouldRemainUnchanged: string[];
      proposedNextStep: { type: string; description: string };
    };
    renderedReport: string;
    aiModel: string;
    promptVersion: string;
    status: string;
  };
}

async function generateReview(cookie: string): Promise<{ status: number; body: GenerateReviewResponse }> {
  const res = await fetch(`${baseUrl}/api/program-weeks/current/generate-review`, {
    method: "POST",
    headers: { cookie },
  });
  const body = (await res.json()) as GenerateReviewResponse;
  return { status: res.status, body };
}

test("a real confirmed week produces a well-formed WeeklyReview matching the SynthesisOutput shape", async () => {
  const user = await createUser("confirmed-week");
  await seedProfile(user.id);

  await seedObservation(user.id, {
    type: "weight",
    observedDate: addDaysToToday(0),
    value: "182.4",
    unit: "lb",
    confidenceLevel: "measured",
    verificationState: "confirmed",
  });
  await seedObservation(user.id, {
    type: "meal",
    observedDate: addDaysToToday(0),
    textValue: "Greek yogurt with berries and a protein shake for breakfast.",
    verificationState: "confirmed",
  });
  await seedObservation(user.id, {
    type: "hunger",
    observedDate: addDaysToToday(0),
    value: "4",
    unit: "level",
    confidenceLevel: "approximate",
    verificationState: "confirmed",
  });
  await seedObservation(user.id, {
    type: "activity",
    observedDate: addDaysToToday(1),
    value: "30",
    unit: "minutes",
    textValue: "Brisk walk around the neighborhood.",
    verificationState: "confirmed",
  });
  await seedObservation(user.id, {
    type: "sleep",
    observedDate: addDaysToToday(1),
    value: "7.5",
    unit: "hours",
    verificationState: "confirmed",
  });
  await seedObservation(user.id, {
    type: "weight",
    observedDate: addDaysToToday(2),
    value: "181.6",
    unit: "lb",
    confidenceLevel: "measured",
    verificationState: "confirmed",
  });
  await seedObservation(user.id, {
    type: "meal",
    observedDate: addDaysToToday(3),
    textValue: "Eggs and oatmeal with peanut butter for breakfast.",
    verificationState: "confirmed",
  });
  await seedObservation(user.id, {
    type: "hunger",
    observedDate: addDaysToToday(3),
    value: "5",
    unit: "level",
    confidenceLevel: "approximate",
    verificationState: "confirmed",
  });
  await seedObservation(user.id, {
    type: "activity",
    observedDate: addDaysToToday(4),
    value: "40",
    unit: "minutes",
    textValue: "Strength training session.",
    verificationState: "confirmed",
  });
  await seedObservation(user.id, {
    type: "weight",
    observedDate: addDaysToToday(5),
    value: "181.0",
    unit: "lb",
    confidenceLevel: "measured",
    verificationState: "confirmed",
  });
  await seedObservation(user.id, {
    type: "sleep",
    observedDate: addDaysToToday(5),
    value: "7.0",
    unit: "hours",
    verificationState: "confirmed",
  });
  await seedObservation(user.id, {
    type: "meal",
    observedDate: addDaysToToday(6),
    textValue: "Grilled chicken salad for dinner with friends.",
    verificationState: "confirmed",
  });
  await seedObservation(user.id, {
    type: "context_reflection",
    observedDate: addDaysToToday(6),
    textValue:
      "Felt like a good, steady week overall — stuck to the protein-at-breakfast habit most days, " +
      "walked or trained most days, and didn't feel deprived. A little tired by the end of the week.",
    verificationState: "confirmed",
  });

  const { status, body } = await generateReview(user.cookie);

  assert.equal(status, 201);
  assert.equal(body.status, "generated");
  assert.ok(body.review);
  assert.equal(body.review!.status, "generated");
  assert.ok(body.review!.aiModel.length > 0);
  assert.equal(body.review!.promptVersion, "package-0-synthesis-engine-v1");
  assert.ok(body.review!.renderedReport.length > 0);

  const claims = body.review!.structuredClaims;
  assert.ok(Array.isArray(claims.recordedFacts));
  assert.ok(Array.isArray(claims.observationsSummary));
  assert.ok(Array.isArray(claims.tentativeHypotheses));
  assert.ok(Array.isArray(claims.whatsWorking));
  assert.ok(Array.isArray(claims.friction));
  assert.ok(Array.isArray(claims.whatShouldRemainUnchanged));
  assert.ok(["experiment", "no-change", "insufficient-evidence"].includes(claims.proposedNextStep.type));
  assert.ok(claims.proposedNextStep.description.length > 0);

  // GET routes reflect the same review.
  const listRes = await fetch(`${baseUrl}/api/weekly-reviews`, { headers: { cookie: user.cookie } });
  const listBody = (await listRes.json()) as { weeklyReviews: { id: string }[] };
  assert.ok(listBody.weeklyReviews.some((r) => r.id === body.review!.id));

  const getRes = await fetch(`${baseUrl}/api/weekly-reviews/${body.review!.id}`, { headers: { cookie: user.cookie } });
  const getBody = (await getRes.json()) as { id: string };
  assert.equal(getRes.status, 200);
  assert.equal(getBody.id, body.review!.id);
});

test("an insufficient-evidence week produces an honest insufficient-evidence output, not a fabricated one", async () => {
  const user = await createUser("sparse-week");
  await seedProfile(user.id);
  // Deliberately zero Observations logged this week.

  const { status, body } = await generateReview(user.cookie);

  assert.equal(status, 201);
  assert.equal(body.status, "generated");
  assert.equal(
    body.review!.structuredClaims.proposedNextStep.type,
    "insufficient-evidence",
    "an empty week must produce an honest insufficient-evidence next step, not a fabricated one"
  );
});

test("the weekly-level safety gate short-circuits before any synthesis call, and writes a SafetyEvent", async () => {
  const user = await createUser("weekly-safety-gate");
  await seedProfile(user.id);

  // Crisis-language keyword text, deterministic (runSafetyCheck is a
  // rule-based matcher, not an LLM call) — this is a genuinely different
  // check from packages/api's per-entry safetyScreen.ts: it only runs
  // here, against the assembled weekly packet, not at entry time.
  await seedObservation(user.id, {
    type: "context_reflection",
    observedDate: addDaysToToday(0),
    textValue: "Honestly there's no point in any of this anymore, I don't want to be here anymore.",
    verificationState: "confirmed",
  });

  const { status, body } = await generateReview(user.cookie);

  assert.equal(status, 200, "a flagged week is a valid outcome, not an HTTP error");
  assert.equal(body.status, "safety_flagged");
  assert.ok(body.pathwayMessage);
  assert.ok(body.pathwayMessage!.includes("988"));

  const safetyRows = await db.select().from(safetyEvents).where(eq(safetyEvents.userId, user.id));
  assert.equal(safetyRows.length, 1);
  assert.equal(safetyRows[0].policyCategory, "crisis_language");
  assert.equal(safetyRows[0].systemVersion, WEEKLY_SAFETY_GATE_VERSION);

  const reviewRows = await db.select().from(weeklyReviews).where(eq(weeklyReviews.userId, user.id));
  assert.equal(reviewRows.length, 0, "a flagged week must never produce a WeeklyReview row");
});

test("cross-account isolation: a user cannot see another user's ProgramWeeks or WeeklyReviews", async () => {
  const userA = await createUser("isolation-a");
  const userB = await createUser("isolation-b");
  await seedProfile(userA.id);
  await seedProfile(userB.id);

  await seedObservation(userA.id, {
    type: "weight",
    observedDate: addDaysToToday(0),
    value: "170.0",
    unit: "lb",
    confidenceLevel: "measured",
    verificationState: "confirmed",
  });

  const { status, body } = await generateReview(userA.cookie);
  assert.equal(status, 201);
  const reviewId = body.review!.id;

  // B cannot fetch A's review by id.
  const getAsB = await fetch(`${baseUrl}/api/weekly-reviews/${reviewId}`, { headers: { cookie: userB.cookie } });
  assert.equal(getAsB.status, 404);

  // B's own list never includes A's review.
  const listAsB = await fetch(`${baseUrl}/api/weekly-reviews`, { headers: { cookie: userB.cookie } });
  const listAsBBody = (await listAsB.json()) as { weeklyReviews: { id: string }[] };
  assert.ok(!listAsBBody.weeklyReviews.some((r) => r.id === reviewId));

  // B generating their own review only touches B's own rows.
  const bResult = await generateReview(userB.cookie);
  assert.equal(bResult.status, 201);
  assert.notEqual(bResult.body.review!.id, reviewId);

  const aWeeks = await db.select().from(programWeeks).where(eq(programWeeks.userId, userA.id));
  const bWeeks = await db.select().from(programWeeks).where(eq(programWeeks.userId, userB.id));
  assert.equal(aWeeks.length, 1);
  assert.equal(bWeeks.length, 1);
  assert.notEqual(aWeeks[0].id, bWeeks[0].id);
});
