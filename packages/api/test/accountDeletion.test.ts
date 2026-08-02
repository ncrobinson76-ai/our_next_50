// Package 11 Part D: the highest-stakes part of this package. Two-step
// account deletion (request -> confirm with a short-lived token), a real
// cascade test across every major table, real object-storage file
// removal, and the deliberate SafetyEvent exception (anonymized via
// ON DELETE SET NULL — see safetyEvents.ts and /OPERATIONS.md — a decision
// made explicitly by the user, not silently by whoever wrote this code).
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
  inboxEvents,
  sourceArtifacts,
  transcripts,
  programWeeks,
  weeklyReviews,
  weeklyReviewInputObservations,
  experiments,
  experimentCompletionObservations,
  safetyEvents,
  accountDeletionRequests,
} from "../src/db";
import { CURRENT_CONSENT_VERSION } from "../src/consent";
import { createScopedDataAccess } from "../src/data/scopedDataAccess";
import { getAudioStorage } from "../src/voice/storage";

type ProfileInsert = InferInsertModel<typeof participantProfiles>;
type ProgramWeekInsert = InferInsertModel<typeof programWeeks>;
type WeeklyReviewInsert = InferInsertModel<typeof weeklyReviews>;
type ObservationInsert = InferInsertModel<typeof observations>;
type ExperimentInsert = InferInsertModel<typeof experiments>;
type SafetyEventInsert = InferInsertModel<typeof safetyEvents>;

let server: Server;
let baseUrl: string;

const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
// Only for users NOT expected to be deleted by their own test — deleted
// users are cleaned up by the deletion itself, re-deleting is harmless
// (delete where id = X matches zero rows) but tracked separately for clarity.
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
  const authProviderId = `test-pkg11del-${label}-${suffix}`;
  const email = `pkg11del-${label}-${suffix}@test.local`;

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

/** Seeds one row in every major user-owned table, including a real object-storage file, so the cascade test has real data everywhere. */
async function seedEverything(userId: string) {
  const profileValues: Omit<ProfileInsert, "id" | "createdAt"> = {
    userId,
    version: 1,
    startingWeightValue: "200.0",
    startingWeightUnit: "lb",
    startingWeightDate: today,
    goals: [{ type: "weight-loss", description: "test goal" }],
    onWeightManagementMedication: false,
  };
  const [profile] = await db.insert(participantProfiles).values(profileValues).returning();

  const obsValues: Omit<ObservationInsert, "id" | "createdAt" | "userId"> = {
    type: "weight",
    observedDate: today,
    value: "199.0",
    unit: "lb",
    confidenceLevel: "measured",
    verificationState: "confirmed",
  };
  const [observation] = await db.insert(observations).values({ userId, ...obsValues }).returning();

  const [inboxEvent] = await db
    .insert(inboxEvents)
    .values({ userId, channel: "voice", status: "processed" })
    .returning();

  const objectKey = `test-deletion/${userId}/${inboxEvent.id}`;
  const storage = getAudioStorage();
  await storage.upload(objectKey, Buffer.from("fake audio bytes for deletion test"));
  // Confirm the file really exists before we ever call deletion.
  await storage.download(objectKey);

  const [artifact] = await db
    .insert(sourceArtifacts)
    .values({
      userId,
      inboxEventId: inboxEvent.id,
      artifactType: "audio",
      mimeType: "audio/webm",
      storageRef: objectKey,
      retentionState: "active",
    })
    .returning();

  await db.insert(transcripts).values({
    userId,
    sourceArtifactId: artifact.id,
    modelName: "test-model",
    text: "test transcript text",
  });

  const weekValues: Omit<ProgramWeekInsert, "id" | "createdAt"> = {
    userId,
    weekStartDate: today,
    weekEndDate: today,
    status: "scheduled",
    evidenceSufficient: false,
  };
  const [week] = await db.insert(programWeeks).values(weekValues).returning();

  const reviewValues: Omit<WeeklyReviewInsert, "id" | "createdAt"> = {
    userId,
    programWeekId: week.id,
    participantProfileVersionId: profile.id,
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
  const [review] = await db.insert(weeklyReviews).values(reviewValues).returning();
  await db.insert(weeklyReviewInputObservations).values({ weeklyReviewId: review.id, observationId: observation.id });

  const experimentValues: Omit<ExperimentInsert, "id" | "createdAt"> = {
    userId,
    weeklyReviewId: review.id,
    recommendation: "test recommendation",
    rationale: "test rationale",
    unchangedBehaviors: [],
    status: "accepted",
    startedAt: new Date(),
  };
  const [experiment] = await db.insert(experiments).values(experimentValues).returning();
  await db.insert(experimentCompletionObservations).values({ experimentId: experiment.id, observationId: observation.id });

  const safetyEventValues: Omit<SafetyEventInsert, "id" | "createdAt"> = {
    userId,
    policyCategory: "crisis_language",
    pathwayKey: "crisis_language",
    systemVersion: "test-version",
  };
  const [safetyEvent] = await db.insert(safetyEvents).values(safetyEventValues).returning();

  return {
    objectKey,
    safetyEventId: safetyEvent.id,
    weeklyReviewId: review.id,
    experimentId: experiment.id,
    observationId: observation.id,
  };
}

interface DeleteRequestResponse {
  token: string;
  expiresAt: string;
}

async function requestDeletion(cookie: string): Promise<DeleteRequestResponse> {
  const res = await fetch(`${baseUrl}/api/account/delete-request`, { method: "POST", headers: { cookie } });
  assert.equal(res.status, 201);
  return (await res.json()) as DeleteRequestResponse;
}

async function confirmDeletion(cookie: string, token: string): Promise<Response> {
  return fetch(`${baseUrl}/api/account/delete-confirm`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

test("delete-request alone performs no deletion — the account and all its data survive", async () => {
  const user = await createUser("no-confirm");
  await seedEverything(user.id);

  await requestDeletion(user.cookie);

  const [userRow] = await db.select().from(users).where(eq(users.id, user.id));
  assert.ok(userRow, "the account must still exist after a request with no confirmation");
  const obsRows = await db.select().from(observations).where(eq(observations.userId, user.id));
  assert.equal(obsRows.length, 1);
});

test("delete-confirm with the wrong token is rejected and performs no deletion", async () => {
  const user = await createUser("wrong-token");
  await seedEverything(user.id);
  await requestDeletion(user.cookie);

  const res = await confirmDeletion(user.cookie, "0000000000000000000000000000000000000000000000000000000000000000");
  assert.equal(res.status, 400);

  const [userRow] = await db.select().from(users).where(eq(users.id, user.id));
  assert.ok(userRow, "a wrong token must never result in deletion");
});

test("delete-confirm with an expired token is rejected", async () => {
  const user = await createUser("expired-token");
  const { token } = await requestDeletion(user.cookie);

  // Force the just-created request into the past.
  await db
    .update(accountDeletionRequests)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(accountDeletionRequests.userId, user.id));

  const res = await confirmDeletion(user.cookie, token);
  assert.equal(res.status, 400);

  const [userRow] = await db.select().from(users).where(eq(users.id, user.id));
  assert.ok(userRow, "an expired token must never result in deletion");
});

test("full cascade deletion: every user-owned table reaches zero rows, EXCEPT SafetyEvents (anonymized, not erased)", async () => {
  const user = await createUser("full-cascade");
  const { objectKey, safetyEventId, weeklyReviewId, experimentId } = await seedEverything(user.id);

  const { token } = await requestDeletion(user.cookie);
  const confirmRes = await confirmDeletion(user.cookie, token);
  assert.equal(confirmRes.status, 200);

  const [userRow] = await db.select().from(users).where(eq(users.id, user.id));
  assert.equal(userRow, undefined);

  for (const table of [
    participantProfiles,
    observations,
    inboxEvents,
    sourceArtifacts,
    transcripts,
    programWeeks,
    weeklyReviews,
    experiments,
    accountDeletionRequests,
  ]) {
    const rows = await db.select().from(table).where(eq(table.userId, user.id));
    assert.equal(rows.length, 0);
  }

  // Junction tables have no userId column of their own — they cascade
  // transitively via their parent (weeklyReviews/experiments), which is
  // already confirmed gone above. Verify directly against the specific
  // rows this test created, by id.
  const remainingReviewLinks = await db
    .select()
    .from(weeklyReviewInputObservations)
    .where(eq(weeklyReviewInputObservations.weeklyReviewId, weeklyReviewId));
  assert.equal(remainingReviewLinks.length, 0);

  const remainingCompletionLinks = await db
    .select()
    .from(experimentCompletionObservations)
    .where(eq(experimentCompletionObservations.experimentId, experimentId));
  assert.equal(remainingCompletionLinks.length, 0);

  // SafetyEvent: the deliberate exception. The row itself survives
  // (anonymized), it is not deleted.
  const [safetyRow] = await db.select().from(safetyEvents).where(eq(safetyEvents.id, safetyEventId));
  assert.ok(safetyRow, "the SafetyEvent row must survive account deletion, per the anonymized-retention decision");
  assert.equal(safetyRow.userId, null, "the surviving SafetyEvent must be anonymized — no link back to the deleted user");
  assert.equal(safetyRow.policyCategory, "crisis_language", "the category itself is preserved, only the user link is severed");

  // Object storage: the file must actually be gone, not just the DB row.
  await assert.rejects(
    () => getAudioStorage().download(objectKey),
    "the audio file must be actually removed from object storage, not just orphaned"
  );
});

test("cross-account isolation: user B cannot trigger or confirm user A's deletion, even holding A's real token", async () => {
  const userA = await createUser("isolation-del-a");
  const userB = await createUser("isolation-del-b");
  await seedEverything(userA.id);

  const { token: aToken } = await requestDeletion(userA.cookie);

  // B attempts to confirm using A's real, valid, unexpired token — but
  // delete-confirm always acts on req.appUser.id (B), and B has no
  // pending request of their own, so this can never touch A's account
  // regardless of what token value B supplies.
  const confirmAsB = await confirmDeletion(userB.cookie, aToken);
  assert.equal(confirmAsB.status, 400);

  const [userARow] = await db.select().from(users).where(eq(users.id, userA.id));
  assert.ok(userARow, "user A's account must be completely unaffected by user B's attempt");

  // B requesting their own deletion only ever creates a row for B.
  const bResult = await requestDeletion(userB.cookie);
  assert.ok(bResult.token);
  const bRequests = await db.select().from(accountDeletionRequests).where(eq(accountDeletionRequests.userId, userB.id));
  assert.equal(bRequests.length, 1);
  const aRequestsUnaffected = await db
    .select()
    .from(accountDeletionRequests)
    .where(eq(accountDeletionRequests.userId, userA.id));
  assert.equal(aRequestsUnaffected.length, 1, "B's actions must not affect A's own pending request");
});
