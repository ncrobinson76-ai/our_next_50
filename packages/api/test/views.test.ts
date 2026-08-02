// Package 11 Parts A/B/C: Progress, Privacy Summary, and Export — all
// read-only rollups of data that already exists, no LLM calls, no new
// writes. Everything here runs against a real DB, no Anthropic calls.
import * as dotenv from "dotenv";
dotenv.config();
process.env.NODE_ENV = "test";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { InferInsertModel } from "drizzle-orm";
import { eq } from "drizzle-orm";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app";
import {
  db,
  users,
  observations,
  participantProfiles,
  programWeeks,
  weeklyReviews,
  experiments,
} from "../src/db";
import { CURRENT_CONSENT_VERSION } from "../src/consent";
import { createScopedDataAccess } from "../src/data/scopedDataAccess";

type ProfileInsert = InferInsertModel<typeof participantProfiles>;
type ProgramWeekInsert = InferInsertModel<typeof programWeeks>;
type WeeklyReviewInsert = InferInsertModel<typeof weeklyReviews>;
type ObservationInsert = InferInsertModel<typeof observations>;
type ExperimentInsert = InferInsertModel<typeof experiments>;

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
  const authProviderId = `test-pkg11-${label}-${suffix}`;
  const email = `pkg11-${label}-${suffix}@test.local`;

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

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
const today = isoDate(new Date());
function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return isoDate(d);
}

async function seedProfile(userId: string, overrides: Partial<ProfileInsert> = {}) {
  const values: Omit<ProfileInsert, "id" | "createdAt"> = {
    userId,
    version: 1,
    startingWeightValue: "200.0",
    startingWeightUnit: "lb",
    startingWeightDate: today,
    goals: [{ type: "weight-loss", description: "test goal" }],
    onWeightManagementMedication: false,
    ...overrides,
  };
  const [row] = await db.insert(participantProfiles).values(values).returning();
  return row;
}

async function seedObservation(userId: string, values: Omit<ObservationInsert, "id" | "createdAt" | "userId">) {
  const [row] = await db.insert(observations).values({ userId, ...values }).returning();
  return row;
}

async function seedProgramWeek(
  userId: string,
  weekStartDate: string,
  weekEndDate: string,
  status: ProgramWeekInsert["status"],
  evidenceSufficient: boolean
) {
  const [row] = await db
    .insert(programWeeks)
    .values({ userId, weekStartDate, weekEndDate, status, evidenceSufficient })
    .returning();
  return row;
}

async function seedWeeklyReview(userId: string, programWeekId: string, participantProfileVersionId: string) {
  const values: Omit<WeeklyReviewInsert, "id" | "createdAt"> = {
    userId,
    programWeekId,
    participantProfileVersionId,
    aiModel: "test-model",
    promptVersion: "test-prompt-version",
    structuredClaims: {
      recordedFacts: [],
      observationsSummary: [],
      tentativeHypotheses: [],
      whatsWorking: [],
      friction: [],
      whatShouldRemainUnchanged: [],
      proposedNextStep: { type: "no-change", description: "placeholder" },
    },
    renderedReport: "placeholder",
    status: "generated",
  };
  const [row] = await db.insert(weeklyReviews).values(values).returning();
  return row;
}

async function seedExperiment(userId: string, overrides: Partial<Omit<ExperimentInsert, "id" | "createdAt" | "userId">> = {}) {
  const values: Omit<ExperimentInsert, "id" | "createdAt"> = {
    userId,
    recommendation: "Add a 20-minute walk after dinner.",
    rationale: "May reduce evening snacking.",
    unchangedBehaviors: [],
    status: "proposed",
    ...overrides,
  };
  const [row] = await db.insert(experiments).values(values).returning();
  return row;
}

// --- Part A: Progress ---

test("progress: weight trend uses confirmed observations only (same trust rule as evidencePacket.ts)", async () => {
  const user = await createUser("progress-weight");
  await seedProfile(user.id);

  await seedObservation(user.id, {
    type: "weight",
    observedDate: daysAgo(10),
    value: "200.0",
    unit: "lb",
    confidenceLevel: "measured",
    verificationState: "confirmed",
  });
  await seedObservation(user.id, {
    type: "weight",
    observedDate: daysAgo(1),
    value: "195.0",
    unit: "lb",
    confidenceLevel: "measured",
    verificationState: "confirmed",
  });
  // Unconfirmed — must never affect the trend.
  await seedObservation(user.id, {
    type: "weight",
    observedDate: today,
    value: "100.0",
    unit: "lb",
    confidenceLevel: "measured",
    verificationState: "proposed",
  });

  const res = await fetch(`${baseUrl}/api/progress`, { headers: { cookie: user.cookie } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    weightTrend: { series: { date: string; value: number }[]; trend?: { deltaValue: number } };
  };

  assert.equal(body.weightTrend.series.length, 2, "the unconfirmed 100lb entry must not appear in the series");
  assert.equal(body.weightTrend.trend?.deltaValue, -5);
});

test("progress: program weeks honestly report skipped weeks, not just totals", async () => {
  const user = await createUser("progress-weeks");
  await seedProfile(user.id);
  await seedProgramWeek(user.id, daysAgo(21), daysAgo(15), "skipped", false);
  await seedProgramWeek(user.id, daysAgo(14), daysAgo(8), "skipped", false);
  await seedProgramWeek(user.id, daysAgo(7), daysAgo(1), "completed", true);

  const res = await fetch(`${baseUrl}/api/progress`, { headers: { cookie: user.cookie } });
  const body = (await res.json()) as {
    programWeeks: { totalElapsed: number; evidenceSufficientCount: number; skippedCount: number };
  };

  assert.equal(body.programWeeks.totalElapsed, 3);
  assert.equal(body.programWeeks.evidenceSufficientCount, 1);
  assert.equal(body.programWeeks.skippedCount, 2, "skipped weeks must be honestly surfaced, not hidden");
});

test("progress: experiment history counts by status and lists active experiments", async () => {
  const user = await createUser("progress-experiments");
  await seedExperiment(user.id, { status: "proposed" });
  await seedExperiment(user.id, { status: "accepted", startedAt: new Date() });
  await seedExperiment(user.id, { status: "declined" });
  await seedExperiment(user.id, { status: "retired", startedAt: new Date() });

  const res = await fetch(`${baseUrl}/api/progress`, { headers: { cookie: user.cookie } });
  const body = (await res.json()) as {
    experiments: { countsByStatus: Record<string, number>; active: { status: string }[] };
  };

  assert.equal(body.experiments.countsByStatus.proposed, 1);
  assert.equal(body.experiments.countsByStatus.accepted, 1);
  assert.equal(body.experiments.countsByStatus.declined, 1);
  assert.equal(body.experiments.countsByStatus.retired, 1);
  assert.equal(body.experiments.active.length, 1);
  assert.equal(body.experiments.active[0].status, "accepted");
});

test("progress: non-scale wins are surfaced as a first-class list, not lost in the noise", async () => {
  const user = await createUser("progress-nsv");
  await seedObservation(user.id, {
    type: "non_scale_win",
    observedDate: daysAgo(3),
    textValue: "Clothes fit noticeably looser.",
    verificationState: "confirmed",
  });
  await seedObservation(user.id, {
    type: "non_scale_win",
    observedDate: daysAgo(1),
    textValue: "Climbed the stairs without getting winded.",
    verificationState: "confirmed",
  });
  // Unconfirmed — should not count.
  await seedObservation(user.id, {
    type: "non_scale_win",
    observedDate: today,
    textValue: "Not yet confirmed win.",
    verificationState: "proposed",
  });

  const res = await fetch(`${baseUrl}/api/progress`, { headers: { cookie: user.cookie } });
  const body = (await res.json()) as { nonScaleWins: { count: number; entries: { description: string }[] } };

  assert.equal(body.nonScaleWins.count, 2);
  assert.ok(body.nonScaleWins.entries.some((e) => e.description.includes("Clothes fit")));
});

// --- Part B: Privacy summary ---

test("privacy summary: counts are accurate and safety events are category-only", async () => {
  const user = await createUser("privacy-counts");
  await seedProfile(user.id);
  await seedObservation(user.id, { type: "weight", observedDate: today, value: "180.0", unit: "lb", verificationState: "confirmed" });
  await seedObservation(user.id, { type: "meal", observedDate: today, textValue: "lunch", verificationState: "confirmed" });

  const res = await fetch(`${baseUrl}/api/privacy/summary`, { headers: { cookie: user.cookie } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    consent: { version: string | null; acceptedAt: string | null };
    counts: {
      participantProfileVersions: number;
      observations: number;
      safetyEventsByCategory: Record<string, number>;
    };
  };

  assert.equal(body.consent.version, CURRENT_CONSENT_VERSION);
  assert.ok(body.consent.acceptedAt);
  assert.equal(body.counts.participantProfileVersions, 1);
  assert.equal(body.counts.observations, 2);
  assert.equal(body.counts.safetyEventsByCategory.urgent_symptom, 0);
  assert.equal(body.counts.safetyEventsByCategory.crisis_language, 0);
  // Every category enum value present, even at zero.
  assert.ok("pregnancy_related" in body.counts.safetyEventsByCategory);
});

// --- Part C: Export ---

test("export: is complete across every user-owned table, including superseded observations", async () => {
  const user = await createUser("export-complete");
  const profile = await seedProfile(user.id);
  const week = await seedProgramWeek(user.id, today, daysAgo(-6), "scheduled", false);
  const review = await seedWeeklyReview(user.id, week.id, profile.id);
  const experiment = await seedExperiment(user.id, { weeklyReviewId: review.id });

  const data = createScopedDataAccess(user.id);

  const original = await seedObservation(user.id, {
    type: "weight",
    observedDate: today,
    value: "180.0",
    unit: "lb",
    verificationState: "confirmed",
  });
  const corrected = await seedObservation(user.id, {
    type: "weight",
    observedDate: today,
    value: "179.0",
    unit: "lb",
    verificationState: "confirmed",
    supersedesObservationId: original.id,
  });
  await db.update(observations).set({ isSuperseded: true }).where(eq(observations.id, original.id));

  await data.weeklyReviewInputObservations.createMany(review.id, [corrected.id]);
  await data.experimentCompletionObservations.createLink(experiment.id, corrected.id);

  const res = await fetch(`${baseUrl}/api/export`, { headers: { cookie: user.cookie } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    account: { id: string; email: string };
    participantProfiles: unknown[];
    observations: { id: string; isSuperseded: boolean }[];
    inboxEvents: unknown[];
    sourceArtifacts: unknown[];
    transcripts: unknown[];
    programWeeks: { id: string }[];
    weeklyReviews: { id: string; inputObservationIds: string[] }[];
    experiments: { id: string; completionObservationIds: string[] }[];
    safetyEvents: unknown[];
  };

  assert.equal(body.account.id, user.id);
  assert.equal(body.participantProfiles.length, 1);

  assert.equal(body.observations.length, 2, "export must include the superseded row, not just the current one");
  const supersededEntry = body.observations.find((o) => o.id === original.id);
  assert.equal(supersededEntry?.isSuperseded, true, "the superseded row must be clearly marked as such");

  assert.equal(body.programWeeks.length, 1);

  const reviewEntry = body.weeklyReviews.find((r) => r.id === review.id);
  assert.ok(reviewEntry);
  assert.deepEqual(reviewEntry!.inputObservationIds, [corrected.id]);

  const experimentEntry = body.experiments.find((e) => e.id === experiment.id);
  assert.ok(experimentEntry);
  assert.deepEqual(experimentEntry!.completionObservationIds, [corrected.id]);

  // Every table-shaped key from the completeness cross-check must be present.
  for (const key of ["inboxEvents", "sourceArtifacts", "transcripts", "safetyEvents"] as const) {
    assert.ok(Array.isArray(body[key]), `${key} must be present in the export, even if empty`);
  }
});

test("cross-account isolation: Progress, Privacy, and Export never leak another user's data", async () => {
  const userA = await createUser("isolation-views-a");
  const userB = await createUser("isolation-views-b");
  await seedProfile(userA.id);
  await seedObservation(userA.id, {
    type: "non_scale_win",
    observedDate: today,
    textValue: "A's private win.",
    verificationState: "confirmed",
  });

  const progressAsB = await fetch(`${baseUrl}/api/progress`, { headers: { cookie: userB.cookie } });
  const progressBodyB = (await progressAsB.json()) as { nonScaleWins: { count: number } };
  assert.equal(progressBodyB.nonScaleWins.count, 0);

  const privacyAsB = await fetch(`${baseUrl}/api/privacy/summary`, { headers: { cookie: userB.cookie } });
  const privacyBodyB = (await privacyAsB.json()) as { counts: { participantProfileVersions: number } };
  assert.equal(privacyBodyB.counts.participantProfileVersions, 0);

  const exportAsB = await fetch(`${baseUrl}/api/export`, { headers: { cookie: userB.cookie } });
  const exportBodyB = (await exportAsB.json()) as { observations: unknown[]; account: { id: string } };
  assert.equal(exportBodyB.observations.length, 0);
  assert.equal(exportBodyB.account.id, userB.id);
});
