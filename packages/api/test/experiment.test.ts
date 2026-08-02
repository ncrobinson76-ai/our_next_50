// Package 10: the Experiment lifecycle (propose -> accept/modify/decline
// -> pause/retire, plus lightweight completion check-ins) and real
// program-week / missed-time recovery logic (PRD Section 8.7), replacing
// Package 9's simplified 7-day-window placeholder.
//
// Everything here runs against a real DB with no LLM calls — creating an
// Experiment from a SynthesisOutput, the whole status-transition lifecycle,
// priorExperiment wiring, and missed-week backfill are all deterministic
// given real seeded data, so none of it needs to gamble on what a model
// would produce (that reuse-the-Package-0-prompt guarantee is already
// covered by test/weeklyReview.test.ts).
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
  experimentCompletionObservations,
} from "../src/db";
import { CURRENT_CONSENT_VERSION } from "../src/consent";
import { createScopedDataAccess } from "../src/data/scopedDataAccess";
import type { SynthesisOutput } from "../src/synthesisCore";
import {
  createExperimentFromSynthesis,
  acceptExperiment,
  modifyExperiment,
  declineExperiment,
  pauseExperiment,
  retireExperiment,
  logCompletion,
} from "../src/experiment/service";
import { findMostRecentEngagedExperiment, buildPriorExperienceContext } from "../src/weeklyReview/priorExperiment";
import {
  EVIDENCE_SUFFICIENCY_MIN_LOGGED_DAYS,
  syncProgramWeeksThroughToday,
} from "../src/weeklyReview/programWeek";

type ProfileInsert = InferInsertModel<typeof participantProfiles>;
type ProgramWeekInsert = InferInsertModel<typeof programWeeks>;
type WeeklyReviewInsert = InferInsertModel<typeof weeklyReviews>;
type ObservationInsert = InferInsertModel<typeof observations>;

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
  const authProviderId = `test-pkg10-${label}-${suffix}`;
  const email = `pkg10-${label}-${suffix}@test.local`;

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

function dateTimeDaysAgo(n: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

async function seedProfile(userId: string, startingWeightDate: string): Promise<InferInsertModel<typeof participantProfiles> & { id: string }> {
  const values: Omit<ProfileInsert, "id" | "createdAt"> = {
    userId,
    version: 1,
    startingWeightValue: "180.0",
    startingWeightUnit: "lb",
    startingWeightDate,
    goals: [{ type: "weight-loss", description: "test goal" }],
    onWeightManagementMedication: false,
  };
  const [row] = await db.insert(participantProfiles).values(values).returning();
  return row as InferSelectRow;
}
type InferSelectRow = InferInsertModel<typeof participantProfiles> & { id: string };

async function seedProgramWeek(
  userId: string,
  weekStartDate: string,
  weekEndDate: string,
  status: ProgramWeekInsert["status"] = "scheduled"
) {
  const [row] = await db
    .insert(programWeeks)
    .values({ userId, weekStartDate, weekEndDate, status, evidenceSufficient: false })
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
    renderedReport: "placeholder report",
    status: "generated",
  };
  const [row] = await db.insert(weeklyReviews).values(values).returning();
  return row;
}

async function seedExperiment(userId: string, overrides: Partial<Omit<InferInsertModel<typeof experiments>, "id" | "createdAt" | "userId">> = {}) {
  const values: Omit<InferInsertModel<typeof experiments>, "id" | "createdAt"> = {
    userId,
    recommendation: "Add a 20-minute walk after dinner most nights.",
    rationale: "May support digestion and reduce evening snacking.",
    unchangedBehaviors: ["Keep breakfast the same"],
    status: "proposed",
    ...overrides,
  };
  const [row] = await db.insert(experiments).values(values).returning();
  return row;
}

async function seedObservation(userId: string, values: Omit<ObservationInsert, "id" | "createdAt" | "userId">) {
  const [row] = await db.insert(observations).values({ userId, ...values }).returning();
  return row;
}

function fakeSynthesis(overrides: Partial<SynthesisOutput> = {}): SynthesisOutput {
  return {
    scenarioId: "test",
    safetyCheck: { flagged: false, categories: [], reasons: [] },
    safetyPathwayTriggered: false,
    recordedFacts: [],
    observationsSummary: [],
    tentativeHypotheses: [],
    whatsWorking: [],
    friction: [],
    whatShouldRemainUnchanged: [],
    proposedNextStep: { type: "no-change", description: "Stay the course." },
    ...overrides,
  };
}

// --- Section 1: creating an Experiment from a SynthesisOutput ---

test("createExperimentFromSynthesis returns null when proposedNextStep.type is not 'experiment'", async () => {
  const user = await createUser("create-null");
  const profile = await seedProfile(user.id, today);
  const week = await seedProgramWeek(user.id, today, daysAgo(-6));
  const review = await seedWeeklyReview(user.id, week.id, profile.id);
  const data = createScopedDataAccess(user.id);

  const result = await createExperimentFromSynthesis(data, review.id, fakeSynthesis({ proposedNextStep: { type: "no-change", description: "x" } }));
  assert.equal(result, null);
});

test("createExperimentFromSynthesis maps recommendation/unchangedBehaviors/rationale directly from the synthesis output", async () => {
  const user = await createUser("create-mapped");
  const profile = await seedProfile(user.id, today);
  const week = await seedProgramWeek(user.id, today, daysAgo(-6));
  const review = await seedWeeklyReview(user.id, week.id, profile.id);
  const data = createScopedDataAccess(user.id);

  const synthesis = fakeSynthesis({
    tentativeHypotheses: ["Hunger may be driven by inconsistent sleep.", "Evening snacking may follow low daytime protein."],
    whatShouldRemainUnchanged: ["Keep logging weight every morning."],
    proposedNextStep: { type: "experiment", description: "Add 20g of protein at breakfast for 5 of 7 days." },
  });

  const result = await createExperimentFromSynthesis(data, review.id, synthesis);
  assert.ok(result);
  assert.equal(result!.recommendation, "Add 20g of protein at breakfast for 5 of 7 days.");
  assert.deepEqual(result!.unchangedBehaviors, ["Keep logging weight every morning."]);
  assert.ok(result!.rationale.includes("Hunger may be driven by inconsistent sleep."));
  assert.ok(result!.rationale.includes("Evening snacking may follow low daytime protein."));
  assert.equal(result!.status, "proposed");
  assert.equal(result!.weeklyReviewId, review.id);
  // Honest gap, not a fabricated value — see experiment/service.ts's header comment.
  assert.equal(result!.target, null);
  assert.equal(result!.difficulty, null);
});

// --- Section 2: status-transition lifecycle (illegal transitions included) ---

test("accept: proposed -> accepted, sets startedAt", async () => {
  const user = await createUser("accept");
  const experiment = await seedExperiment(user.id);
  const data = createScopedDataAccess(user.id);

  const result = await acceptExperiment(data, experiment.id);
  assert.ok(result.ok);
  assert.equal(result.experiment.status, "accepted");
  assert.ok(result.experiment.startedAt);
});

test("modify: proposed -> modified, overwrites recommendation and audits the original in rationale", async () => {
  const user = await createUser("modify");
  const experiment = await seedExperiment(user.id, { recommendation: "Original recommendation text." });
  const data = createScopedDataAccess(user.id);

  const result = await modifyExperiment(data, experiment.id, "My edited version of the recommendation.");
  assert.ok(result.ok);
  assert.equal(result.experiment.status, "modified");
  assert.equal(result.experiment.recommendation, "My edited version of the recommendation.");
  assert.ok(result.experiment.rationale.includes("Original recommendation text."));
  assert.ok(result.experiment.startedAt);
});

test("decline: proposed -> declined", async () => {
  const user = await createUser("decline");
  const experiment = await seedExperiment(user.id);
  const data = createScopedDataAccess(user.id);

  const result = await declineExperiment(data, experiment.id);
  assert.ok(result.ok);
  assert.equal(result.experiment.status, "declined");
});

test("illegal transitions are rejected server-side, not just skipped in the happy path", async () => {
  const user = await createUser("illegal");
  const data = createScopedDataAccess(user.id);

  const declined = await seedExperiment(user.id, { status: "declined" });
  const acceptDeclined = await acceptExperiment(data, declined.id);
  assert.equal(acceptDeclined.ok, false);
  if (!acceptDeclined.ok) {
    assert.equal(acceptDeclined.reason, "illegal_transition");
    if (acceptDeclined.reason === "illegal_transition") {
      assert.equal(acceptDeclined.from, "declined");
      assert.equal(acceptDeclined.to, "accepted");
    }
  }

  const retired = await seedExperiment(user.id, { status: "retired", startedAt: dateTimeDaysAgo(3) });
  const retireRetired = await retireExperiment(data, retired.id);
  assert.equal(retireRetired.ok, false);

  const accepted = await seedExperiment(user.id, { status: "accepted", startedAt: dateTimeDaysAgo(1) });
  const modifyAccepted = await modifyExperiment(data, accepted.id, "trying to sneak an edit in");
  assert.equal(modifyAccepted.ok, false);
  if (!modifyAccepted.ok) assert.equal(modifyAccepted.reason, "illegal_transition");

  const paused = await seedExperiment(user.id, { status: "paused", startedAt: dateTimeDaysAgo(2) });
  const pauseAgain = await pauseExperiment(data, paused.id);
  assert.equal(pauseAgain.ok, false);

  const proposed = await seedExperiment(user.id);
  const pauseProposed = await pauseExperiment(data, proposed.id);
  assert.equal(pauseProposed.ok, false);
});

test("pause and retire both work from accepted or modified", async () => {
  const user = await createUser("pause-retire");
  const data = createScopedDataAccess(user.id);

  const accepted = await seedExperiment(user.id, { status: "accepted", startedAt: dateTimeDaysAgo(1) });
  const paused = await pauseExperiment(data, accepted.id);
  assert.ok(paused.ok);
  assert.equal(paused.experiment.status, "paused");

  const modified = await seedExperiment(user.id, { status: "modified", startedAt: dateTimeDaysAgo(1) });
  const retiredFromModified = await retireExperiment(data, modified.id, "Decided it wasn't worth continuing.");
  assert.ok(retiredFromModified.ok);
  assert.equal(retiredFromModified.experiment.status, "retired");
  assert.equal(retiredFromModified.experiment.outcome, "Decided it wasn't worth continuing.");

  const pausedExp = await seedExperiment(user.id, { status: "paused", startedAt: dateTimeDaysAgo(1) });
  const retiredFromPaused = await retireExperiment(data, pausedExp.id);
  assert.ok(retiredFromPaused.ok);
  assert.equal(retiredFromPaused.experiment.status, "retired");
});

test("acting on a nonexistent experiment id returns not_found", async () => {
  const user = await createUser("not-found");
  const data = createScopedDataAccess(user.id);
  const result = await acceptExperiment(data, "00000000-0000-0000-0000-000000000000");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "not_found");
});

// --- Section 3: log-completion ---

test("log-completion only works while accepted or modified, never on a merely-proposed experiment", async () => {
  const user = await createUser("log-completion-gate");
  const data = createScopedDataAccess(user.id);

  const proposed = await seedExperiment(user.id);
  const onProposed = await logCompletion(data, proposed.id, { completed: true, date: today });
  assert.equal(onProposed.ok, false);
  if (!onProposed.ok) assert.equal(onProposed.reason, "not_active");

  const accepted = await seedExperiment(user.id, { status: "accepted", startedAt: dateTimeDaysAgo(1) });
  const onAccepted = await logCompletion(data, accepted.id, { completed: true, date: today, note: "Did it after dinner." });
  assert.ok(onAccepted.ok);

  const obsRows = await db.select().from(observations).where(eq(observations.id, (onAccepted as { observationId: string }).observationId));
  assert.equal(obsRows.length, 1);
  assert.equal(obsRows[0].type, "experiment_completion");
  assert.equal(obsRows[0].isExplicitNonEvent, false);
  assert.equal(obsRows[0].textValue, "Did it after dinner.");

  const linkRows = await db
    .select()
    .from(experimentCompletionObservations)
    .where(eq(experimentCompletionObservations.experimentId, accepted.id));
  assert.equal(linkRows.length, 1);

  const modified = await seedExperiment(user.id, { status: "modified", startedAt: dateTimeDaysAgo(1) });
  const onModified = await logCompletion(data, modified.id, { completed: false, date: today });
  assert.ok(onModified.ok);
});

test("log-completion with completed=false stores an explicit non-event", async () => {
  const user = await createUser("log-completion-non-event");
  const data = createScopedDataAccess(user.id);
  const accepted = await seedExperiment(user.id, { status: "accepted", startedAt: dateTimeDaysAgo(1) });

  const result = await logCompletion(data, accepted.id, { completed: false, date: today });
  assert.ok(result.ok);
  const obsRows = await db.select().from(observations).where(eq(observations.id, (result as { observationId: string }).observationId));
  assert.equal(obsRows[0].isExplicitNonEvent, true);
});

// --- Section 4: priorExperiment wiring (the full lifecycle -> next-week-packet path) ---

test("propose -> accept -> log completions -> a later week's priorExperiment context correctly includes it", async () => {
  const user = await createUser("prior-experiment");
  const data = createScopedDataAccess(user.id);

  // The experiment "started" 9 days ago (some earlier week); a later
  // week's evidence packet is being assembled for the window starting 3
  // days ago — findMostRecentEngagedExperiment just needs that later
  // week's own weekStartDate, it doesn't care how it was computed.
  const experiment = await seedExperiment(user.id, {
    recommendation: "Add a 20-minute walk after dinner most nights.",
    rationale: "May support digestion and reduce evening snacking.",
    status: "accepted",
    startedAt: dateTimeDaysAgo(9),
  });

  const doneResult = await logCompletion(data, experiment.id, { completed: true, date: daysAgo(8) });
  const notDoneResult = await logCompletion(data, experiment.id, { completed: false, date: daysAgo(7), note: "Too tired." });
  assert.ok(doneResult.ok);
  assert.ok(notDoneResult.ok);

  const laterWeekStartDate = daysAgo(3);

  const found = await findMostRecentEngagedExperiment(data, laterWeekStartDate);
  assert.ok(found);
  assert.equal(found!.id, experiment.id);

  const context = await buildPriorExperienceContext(data, found!);
  assert.equal(context.description, "Add a 20-minute walk after dinner most nights.");
  assert.equal(context.hypothesis, "May support digestion and reduce evening snacking.");
  assert.equal(context.status, "ongoing");
  assert.equal(context.startDate, daysAgo(9));
  assert.ok(context.outcomeNotes?.includes("done on 1"));
  assert.ok(context.outcomeNotes?.includes("not done on 1"));

  // A week strictly before the experiment even started must correctly find none.
  const beforeItStarted = await findMostRecentEngagedExperiment(data, daysAgo(30));
  assert.equal(beforeItStarted, null);
});

test("a user with no engaged experiment correctly gets no priorExperiment, not a fabricated one", async () => {
  const user = await createUser("no-prior-experiment");
  const data = createScopedDataAccess(user.id);
  await seedExperiment(user.id, { status: "proposed" }); // never accepted — must not count
  await seedExperiment(user.id, { status: "declined" }); // declined — must not count

  const found = await findMostRecentEngagedExperiment(data, today);
  assert.equal(found, null);
});

// --- Section 5: missed-week backfill honesty (PRD Section 8.7) ---

test("a user who skips 2+ weeks gets honest missed ProgramWeek records, not a silent jump to 'current week'", async () => {
  const user = await createUser("missed-weeks");
  const data = createScopedDataAccess(user.id);
  // Program started 22 days ago -> today falls in week index floor(22/7) = 3.
  const programStartDate = daysAgo(22);

  const result = await syncProgramWeeksThroughToday(data, programStartDate);

  assert.equal(result.backfilled.length, 3, "weeks 0, 1, and 2 must all be backfilled");
  for (const week of result.backfilled) {
    assert.equal(week.status, "skipped", "a missed week must be honestly marked skipped, not silently absent");
  }
  assert.notEqual(result.current.status, "skipped");

  const allWeeks = await data.programWeeks.list();
  assert.equal(allWeeks.length, 4, "exactly 4 weeks (0 through 3) must exist — no gap silently skipped over");

  const sorted = [...allWeeks].sort((a, b) => a.weekStartDate.localeCompare(b.weekStartDate));
  for (let i = 1; i < sorted.length; i++) {
    const prevEnd = new Date(`${sorted[i - 1].weekEndDate}T00:00:00.000Z`);
    const thisStart = new Date(`${sorted[i].weekStartDate}T00:00:00.000Z`);
    const gapDays = Math.round((thisStart.getTime() - prevEnd.getTime()) / (1000 * 60 * 60 * 24));
    assert.equal(gapDays, 1, "sequential weeks must be back-to-back with no unaccounted gap between them");
  }
  assert.equal(sorted[3].id, result.current.id);
});

test("an existing past ProgramWeek stuck at 'scheduled' is corrected to 'skipped' on a later sync, not left inaccurate", async () => {
  const user = await createUser("stuck-scheduled");
  const data = createScopedDataAccess(user.id);
  const programStartDate = daysAgo(15); // today falls in week index floor(15/7) = 2

  // Simulate: the user opened the app once during week 1 (creating that
  // ProgramWeek row) but never generated a review for it, then vanished.
  const week1Start = daysAgo(15 - 7); // = daysAgo(8)
  const week1End = daysAgo(15 - 13); // 6 days after week1Start
  await seedProgramWeek(user.id, week1Start, week1End, "scheduled");

  const result = await syncProgramWeeksThroughToday(data, programStartDate);

  const correctedWeek1 = result.backfilled.find((w) => w.weekStartDate === week1Start);
  assert.ok(correctedWeek1, "the pre-existing week-1 row must be found and corrected, not ignored");
  assert.equal(correctedWeek1!.status, "skipped");

  const week0 = result.backfilled.find((w) => w.weekStartDate !== week1Start);
  assert.ok(week0, "week 0 (which had no row at all) must also be backfilled");
  assert.equal(week0!.status, "skipped");
});

// --- Section 6: evidence-sufficiency flag ---

test("evidence-sufficiency flag is correctly set on a sparse week", async () => {
  const user = await createUser("sparse-evidence");
  const data = createScopedDataAccess(user.id);
  const programStartDate = today;

  assert.ok(EVIDENCE_SUFFICIENCY_MIN_LOGGED_DAYS > 1, "sanity check on the threshold constant");

  await seedObservation(user.id, {
    type: "weight",
    observedDate: today,
    value: "180.0",
    unit: "lb",
    confidenceLevel: "measured",
    verificationState: "confirmed",
  });

  const result = await syncProgramWeeksThroughToday(data, programStartDate);
  assert.equal(result.current.evidenceSufficient, false, "1 logged day is below the sufficiency threshold");
});

test("evidence-sufficiency flag is correctly set on a well-logged week", async () => {
  const user = await createUser("rich-evidence");
  const data = createScopedDataAccess(user.id);
  const programStartDate = today;

  // One Observation per distinct day, exactly at the threshold — the flag
  // counts distinct logged *days*, not raw Observation rows, so these must
  // land on genuinely different dates within the current week.
  for (let i = 0; i < EVIDENCE_SUFFICIENCY_MIN_LOGGED_DAYS; i++) {
    await seedObservation(user.id, {
      type: "weight",
      observedDate: daysAgo(-i),
      value: String(180 - i),
      unit: "lb",
      confidenceLevel: "measured",
      verificationState: "confirmed",
    });
  }

  const result = await syncProgramWeeksThroughToday(data, programStartDate);
  assert.equal(result.current.evidenceSufficient, true, `${EVIDENCE_SUFFICIENCY_MIN_LOGGED_DAYS} logged days meets the sufficiency threshold`);
});

// --- Section 7: cross-account isolation for all new routes ---

test("cross-account isolation: a user cannot act on another user's Experiment via any lifecycle route", async () => {
  const userA = await createUser("isolation-exp-a");
  const userB = await createUser("isolation-exp-b");
  const experiment = await seedExperiment(userA.id, { status: "proposed" });

  const acceptAsB = await fetch(`${baseUrl}/api/experiments/${experiment.id}/accept`, {
    method: "POST",
    headers: { cookie: userB.cookie },
  });
  assert.equal(acceptAsB.status, 404);

  const acceptedByA = await acceptExperiment(createScopedDataAccess(userA.id), experiment.id);
  assert.ok(acceptedByA.ok);

  const logAsB = await fetch(`${baseUrl}/api/experiments/${experiment.id}/log-completion`, {
    method: "POST",
    headers: { cookie: userB.cookie, "content-type": "application/json" },
    body: JSON.stringify({ completed: true, date: today }),
  });
  assert.equal(logAsB.status, 404);

  const retireAsB = await fetch(`${baseUrl}/api/experiments/${experiment.id}/retire`, {
    method: "POST",
    headers: { cookie: userB.cookie },
  });
  assert.equal(retireAsB.status, 404);
});

test("cross-account isolation: GET /api/program-weeks never includes another user's weeks", async () => {
  const userA = await createUser("isolation-pw-a");
  const userB = await createUser("isolation-pw-b");

  await seedProgramWeek(userA.id, today, daysAgo(-6), "scheduled");

  const listAsB = await fetch(`${baseUrl}/api/program-weeks`, { headers: { cookie: userB.cookie } });
  const bodyB = (await listAsB.json()) as { programWeeks: { id: string }[] };
  assert.equal(bodyB.programWeeks.length, 0);

  const listAsA = await fetch(`${baseUrl}/api/program-weeks`, { headers: { cookie: userA.cookie } });
  const bodyA = (await listAsA.json()) as { programWeeks: { id: string }[] };
  assert.equal(bodyA.programWeeks.length, 1);
});

// --- HTTP-level checks: validation and error shapes on the routes themselves ---

test("HTTP: illegal transition returns 409 with from/to, invalid modify body returns 400", async () => {
  const user = await createUser("http-validation");
  const declined = await seedExperiment(user.id, { status: "declined" });

  const acceptRes = await fetch(`${baseUrl}/api/experiments/${declined.id}/accept`, {
    method: "POST",
    headers: { cookie: user.cookie },
  });
  assert.equal(acceptRes.status, 409);
  const acceptBody = (await acceptRes.json()) as { error: string; from: string; to: string };
  assert.equal(acceptBody.error, "illegal_transition");
  assert.equal(acceptBody.from, "declined");
  assert.equal(acceptBody.to, "accepted");

  const proposed = await seedExperiment(user.id);
  const modifyRes = await fetch(`${baseUrl}/api/experiments/${proposed.id}/modify`, {
    method: "POST",
    headers: { cookie: user.cookie, "content-type": "application/json" },
    body: JSON.stringify({ recommendation: "" }),
  });
  assert.equal(modifyRes.status, 400);

  const logRes = await fetch(`${baseUrl}/api/experiments/${proposed.id}/log-completion`, {
    method: "POST",
    headers: { cookie: user.cookie, "content-type": "application/json" },
    body: JSON.stringify({ completed: "yes", date: "not-a-date" }),
  });
  assert.equal(logRes.status, 400);
});
