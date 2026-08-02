// Package 12: the final package. No new features — this file is the
// strongest single piece of evidence for PRD Section 15's Phase 1
// definition of done, chaining a realistic session across every package
// built so far (0 through 11), rather than testing each package against
// its own isolated fixtures the way every other test file in this repo
// does. See PHASE_1_STATUS.md at the repo root for how this test's
// assertions map onto each of the 12 Section 15 items.
//
// Two tests live here: the golden path (one continuous realistic session),
// and a separate multi-week-gap test (PRD Section 15 item 8 specifically —
// missed time must produce a neutral, honest recovery, never fabricated
// continuity).
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
import { db, users, observations, experiments, participantProfiles, programWeeks } from "../src/db";
import { CURRENT_CONSENT_VERSION } from "../src/consent";
import { createScopedDataAccess } from "../src/data/scopedDataAccess";
import { findMostRecentEngagedExperiment, buildPriorExperienceContext } from "../src/weeklyReview/priorExperiment";

type ObservationInsert = InferInsertModel<typeof observations>;
type ProfileInsert = InferInsertModel<typeof participantProfiles>;

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
  // Harmless for the golden-path user, who deletes themselves as part of
  // the test — a delete matching zero rows is a no-op, not an error.
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id));
  }
});

function extractCookie(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  assert.ok(setCookie, "expected a Set-Cookie header from login");
  return setCookie!.split(";")[0];
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

// =====================================================================
// Golden path: create account -> onboard -> log via all three channels
// -> confirm/correct -> weekly review -> accept experiment -> log
// completion -> priorExperiment wiring -> Progress/Privacy views ->
// export -> two-step deletion.
// =====================================================================
test("golden path: a realistic end-to-end session across every package", async () => {
  const authProviderId = `test-pkg12-golden-${suffix}`;
  const email = `pkg12-golden-${suffix}@test.local`;

  // --- Item 1 evidence: secure individual account + informed onboarding ---
  // Deliberately does NOT pre-insert the users row the way every other
  // test file's createUser() helper does — this is the one test where we
  // want the REAL account-creation path exercised: login-as establishes
  // only a session (no DB row), the first authenticated request makes
  // resolveAppUser create the users row for real (matching production's
  // actual "first login creates the account" flow), and consent is
  // accepted through the real POST /api/consent/accept route rather than
  // being pre-seeded.
  const loginRes = await fetch(`${baseUrl}/api/_test/login-as`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ authProviderId, email }),
  });
  assert.equal(loginRes.status, 200);
  const cookie = extractCookie(loginRes);

  const consentBefore = await fetch(`${baseUrl}/api/consent`, { headers: { cookie } });
  const consentBeforeBody = (await consentBefore.json()) as { accepted: boolean; version: string };
  assert.equal(consentBeforeBody.accepted, false, "a brand-new account must not appear pre-consented");

  const acceptRes = await fetch(`${baseUrl}/api/consent/accept`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ version: CURRENT_CONSENT_VERSION }),
  });
  assert.equal(acceptRes.status, 200);
  const acceptBody = (await acceptRes.json()) as { accepted: boolean; user: { id: string } };
  assert.equal(acceptBody.accepted, true);
  const userId = acceptBody.user.id;
  createdUserIds.push(userId);

  // "Informed onboarding" continues with the baseline profile — program
  // start anchored 13 days ago. weekIndexForDate = floor(daysSinceStart/7),
  // so 13 days gives index 1 (the account's real SECOND program week) with
  // its window computed as [daysAgo(6), today] — 13 mod 7 = 6, so today
  // lands on the LAST day of that window, leaving daysAgo(6) through
  // daysAgo(1) all inside the SAME current week for this session's
  // "already logged earlier this week" seed data below. Week index 0,
  // entirely before this window, has no data and will be honestly
  // backfilled as "skipped" the first time a review is generated — see
  // the priorExperiment section below for why this matters for item 6/7's
  // "advance to a second program week."
  const onboardRes = await fetch(`${baseUrl}/api/participant-profiles`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      dateOfBirth: "1985-04-12",
      startingWeight: { value: 184.0, unit: "lb", date: daysAgo(13) },
      goals: [{ type: "weight-loss", description: "Feel stronger and steadier day to day." }],
      typicalEatingPattern: "Three meals a day, sometimes an evening snack.",
      typicalActivityPattern: "Walks most days.",
      onWeightManagementMedication: false,
    }),
  });
  assert.equal(onboardRes.status, 201, "onboarding must succeed for a fresh account");
  const profile = (await onboardRes.json()) as { id: string; version: number };
  assert.equal(profile.version, 1);

  // --- Item 2 + 3 evidence: submit via text, form, and voice; the system
  // transcribes/structures, identifies uncertainty (proposed, not
  // confirmed), and screens for safety before any of that ---
  const textRes = await fetch(`${baseUrl}/api/inbox/text`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ text: "Weighed in at 182.4 lbs this morning. Feeling steady." }),
  });
  assert.equal(textRes.status, 201);
  const textEvent = (await textRes.json()) as { id: string };

  const formRes = await fetch(`${baseUrl}/api/inbox/form`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      weight: { value: 181.8, unit: "lb" },
      hungerLevel: 4,
      note: "Had a good breakfast with protein, wasn't as hungry before lunch.",
    }),
  });
  assert.equal(formRes.status, 201);
  const formEvent = (await formRes.json()) as { id: string };

  const voiceForm = new FormData();
  voiceForm.append(
    "audio",
    new Blob([Buffer.from("fake audio bytes")], { type: "audio/webm" }),
    "memo.webm"
  );
  voiceForm.append("mockTranscriptText", "Went for a 30 minute walk after dinner and felt great, no evening snacking tonight.");
  const voiceRes = await fetch(`${baseUrl}/api/inbox/voice`, {
    method: "POST",
    headers: { cookie },
    body: voiceForm,
  });
  assert.equal(voiceRes.status, 200, "voice upload + mocked transcription + the shared pipeline must succeed");
  const voiceBody = (await voiceRes.json()) as { status: string; observations?: { id: string; type: string }[] };
  assert.notEqual(voiceBody.status, "safety_flagged", "benign voice content must not trip the safety gate");

  // Text and form need an explicit process step (Package 5); voice already
  // ran the shared pipeline synchronously as part of the upload
  // (Package 6) — same unmodified pipeline either way, per INB-01.
  const textProcessRes = await fetch(`${baseUrl}/api/inbox/${textEvent.id}/process`, { method: "POST", headers: { cookie } });
  assert.equal(textProcessRes.status, 200);
  const textResult = (await textProcessRes.json()) as { status: string; observations?: { id: string; type: string }[] };
  assert.equal(textResult.status, "processed");

  const formProcessRes = await fetch(`${baseUrl}/api/inbox/${formEvent.id}/process`, { method: "POST", headers: { cookie } });
  assert.equal(formProcessRes.status, 200);
  const formResult = (await formProcessRes.json()) as { status: string; observations?: { id: string; type: string }[] };
  assert.equal(formResult.status, "processed");

  const allProposed = [...(textResult.observations ?? []), ...(formResult.observations ?? []), ...(voiceBody.observations ?? [])];
  assert.ok(allProposed.length > 0, "all three channels must produce at least one candidate Observation");

  const rawProposedRows = await db.select().from(observations).where(eq(observations.userId, userId));
  assert.ok(
    rawProposedRows.every((r) => r.verificationState === "proposed"),
    "every freshly extracted Observation must start life as proposed, never auto-confirmed — item 3's 'identifies uncertainty'"
  );

  // --- Item 4 evidence: the participant can inspect/edit; confirm one, correct another ---
  const textWeightObs = rawProposedRows.find((r) => r.type === "weight" && r.sourceInboxEventId === textEvent.id);
  assert.ok(textWeightObs, "the text entry must have produced a weight Observation to confirm");
  const confirmRes = await fetch(`${baseUrl}/api/observations/${textWeightObs!.id}/confirm`, { method: "POST", headers: { cookie } });
  assert.equal(confirmRes.status, 200);
  const confirmedObs = (await confirmRes.json()) as { verificationState: string };
  assert.equal(confirmedObs.verificationState, "confirmed");

  const formHungerObs = rawProposedRows.find((r) => r.type === "hunger" && r.sourceInboxEventId === formEvent.id);
  assert.ok(formHungerObs, "the form entry must have produced a hunger Observation to correct");
  const correctRes = await fetch(`${baseUrl}/api/observations/${formHungerObs!.id}/correct`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ value: 5, correctionReason: "Actually a bit hungrier than I first said." }),
  });
  assert.equal(correctRes.status, 201, "a correction creates a new superseding row, not an in-place edit");
  const correctedObs = (await correctRes.json()) as { verificationState: string; value: string | number };
  assert.equal(correctedObs.verificationState, "confirmed", "a user's own correction is authoritative — confirmed immediately");

  // --- Supplementary confirmed logging on earlier days this week, plus
  // one deliberately UNCONFIRMED extreme value — sets up both a data-rich
  // week (enough for a normal synthesis, not insufficient-evidence) and
  // the "confirmed data only" check below. Not every day of a real week
  // goes through the extraction pipeline end-to-end in this single test
  // (that mechanism is already exercised above for one entry per channel)
  // — these represent days already logged and confirmed earlier this
  // week.
  const data = createScopedDataAccess(userId);
  async function seedConfirmed(values: Omit<ObservationInsert, "id" | "createdAt" | "userId">) {
    return data.observations.create(values);
  }
  await seedConfirmed({ type: "weight", observedDate: daysAgo(3), value: "184.0", unit: "lb", confidenceLevel: "measured", verificationState: "confirmed" });
  await seedConfirmed({ type: "meal", observedDate: daysAgo(3), textValue: "Oatmeal with peanut butter for breakfast.", verificationState: "confirmed" });
  await seedConfirmed({ type: "hunger", observedDate: daysAgo(3), value: "6", unit: "level", textValue: "Hunger picked up before dinner.", verificationState: "confirmed" });
  await seedConfirmed({ type: "weight", observedDate: daysAgo(2), value: "183.5", unit: "lb", confidenceLevel: "measured", verificationState: "confirmed" });
  await seedConfirmed({ type: "meal", observedDate: daysAgo(2), textValue: "Eggs and toast for breakfast.", verificationState: "confirmed" });
  await seedConfirmed({ type: "weight", observedDate: daysAgo(1), value: "183.0", unit: "lb", confidenceLevel: "measured", verificationState: "confirmed" });
  await seedConfirmed({ type: "activity", observedDate: daysAgo(1), value: "20", unit: "minutes", textValue: "Evening walk.", verificationState: "confirmed" });
  await seedConfirmed({ type: "hunger", observedDate: daysAgo(1), value: "6", unit: "level", textValue: "Hungry again in the evening, had an extra snack.", verificationState: "confirmed" });
  await seedConfirmed({
    type: "context_reflection",
    observedDate: today,
    textValue:
      "This week felt pretty good overall — dinner protein and my morning walks are becoming routine, though I still " +
      "get hungry most evenings and don't always have a good plan for it.",
    verificationState: "confirmed",
  });

  // The unconfirmed marker: a wildly implausible value that must NEVER
  // read as fact in the generated review below.
  const FABRICATED_MARKER = "911.7";
  await seedConfirmed({
    type: "weight",
    observedDate: today,
    value: FABRICATED_MARKER,
    unit: "lb",
    confidenceLevel: "measured",
    verificationState: "proposed",
  });

  // --- Item 5 evidence: a completed program week produces one evidence-
  // aware review separating facts/observations/hypotheses/unknowns/
  // what-should-remain-unchanged ---
  const reviewRes = await fetch(`${baseUrl}/api/program-weeks/current/generate-review`, { method: "POST", headers: { cookie } });
  assert.equal(reviewRes.status, 201, "a data-rich confirmed week must generate a real review, not short-circuit");
  const reviewBody = (await reviewRes.json()) as {
    status: string;
    review: {
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
    };
  };
  assert.equal(reviewBody.status, "generated");
  const claims = reviewBody.review.structuredClaims;
  for (const section of [
    claims.recordedFacts,
    claims.observationsSummary,
    claims.tentativeHypotheses,
    claims.whatsWorking,
    claims.friction,
    claims.whatShouldRemainUnchanged,
  ]) {
    assert.ok(Array.isArray(section), "each of the five separated sections must be present, even if empty");
  }

  // The "confirmed data only" guarantee, checked end-to-end through the
  // REAL LLM call (not just the deterministic packet-assembly unit test
  // in test/weeklyReview.test.ts). Mentioning the fabricated value at all
  // is fine and even good transparency — evidencePacket.ts deliberately
  // surfaces unconfirmed data as hedged text, not by hiding it — the
  // violation would be stating it as PLAIN, UNQUALIFIED fact. Check each
  // recordedFacts entry individually: if the marker appears in one, that
  // same sentence must carry explicit hedging language.
  const HEDGE_WORDS = ["unconfirmed", "not confirmed", "not verified", "flagged", "not treated as"];
  const entriesWithMarker = claims.recordedFacts.filter((f) => f.includes(FABRICATED_MARKER));
  for (const entry of entriesWithMarker) {
    assert.ok(
      HEDGE_WORDS.some((w) => entry.toLowerCase().includes(w)),
      `the fabricated, unconfirmed weight value must be explicitly hedged if mentioned in recordedFacts, never stated as plain fact: "${entry}"`
    );
  }

  // --- Item 6 + 7 evidence: one manageable experiment recommended (or an
  // explicit no-change/insufficient-evidence with reasoning either way),
  // and the participant can act on it ---
  assert.ok(
    ["experiment", "no-change", "insufficient-evidence"].includes(claims.proposedNextStep.type),
    "proposedNextStep must be exactly one of the three valid types"
  );
  assert.ok(claims.proposedNextStep.description.length > 0, "the recommendation must explain why, not just what");

  if (claims.proposedNextStep.type === "experiment") {
    const [experimentRow] = await db.select().from(experiments).where(eq(experiments.userId, userId));
    assert.ok(experimentRow, "an 'experiment' proposedNextStep must have created a real Experiment row");

    const acceptExpRes = await fetch(`${baseUrl}/api/experiments/${experimentRow.id}/accept`, { method: "POST", headers: { cookie } });
    assert.equal(acceptExpRes.status, 200);
    const acceptedExp = (await acceptExpRes.json()) as { status: string; startedAt: string };
    assert.equal(acceptedExp.status, "accepted");
    assert.ok(acceptedExp.startedAt);

    const logRes = await fetch(`${baseUrl}/api/experiments/${experimentRow.id}/log-completion`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ completed: true, date: today, note: "Tried it — worked well." }),
    });
    assert.equal(logRes.status, 201, "logging a completion against a just-accepted experiment must succeed");

    // --- priorExperiment wiring for "a second program week" ---
    // A literal third HTTP call for a genuinely later calendar week isn't
    // possible within one test run at a single wall-clock moment (this
    // account's program start date is fixed and, by design, never
    // shifts — see weeklyReview/programWeek.ts's own comment on why it's
    // pinned to an immutable version-1 field). Package 10's own test
    // suite established the right way to verify this without time travel:
    // call the real priorExperiment functions directly against the real,
    // just-created Experiment and completion, parameterized with the
    // date a genuinely later week would start on.
    const currentWeekRows = await db.select().from(programWeeks).where(eq(programWeeks.userId, userId));
    const currentWeek = currentWeekRows.find((w) => w.weekStartDate <= today && w.weekEndDate >= today)!;
    const nextWeekStart = new Date(`${currentWeek.weekEndDate}T00:00:00.000Z`);
    nextWeekStart.setUTCDate(nextWeekStart.getUTCDate() + 1);
    const nextWeekStartDate = isoDate(nextWeekStart);

    const foundPrior = await findMostRecentEngagedExperiment(data, nextWeekStartDate);
    assert.ok(foundPrior, "the just-accepted experiment must be findable as a prior experiment for a subsequent week");
    assert.equal(foundPrior!.id, experimentRow.id);

    const priorContext = await buildPriorExperienceContext(data, foundPrior!);
    assert.equal(priorContext.description, experimentRow.recommendation);
    assert.equal(priorContext.status, "ongoing");
    assert.ok(priorContext.outcomeNotes?.includes("done on 1"), "the logged completion must be reflected in the prior-experience summary");
  }

  // --- Item 10 evidence, part 1: Progress and Privacy views ---
  const progressRes = await fetch(`${baseUrl}/api/progress`, { headers: { cookie } });
  assert.equal(progressRes.status, 200);
  const progressBody = (await progressRes.json()) as {
    weightTrend: { series: unknown[] };
    programWeeks: { totalElapsed: number; skippedCount: number };
  };
  assert.ok(progressBody.weightTrend.series.length > 0, "confirmed weight entries must appear in the Progress view");
  assert.ok(progressBody.programWeeks.totalElapsed >= 2, "the account's real second week plus the auto-backfilled first week must both be counted");
  assert.equal(progressBody.programWeeks.skippedCount, 1, "the empty first week must be honestly reported as skipped, not hidden");

  const privacyRes = await fetch(`${baseUrl}/api/privacy/summary`, { headers: { cookie } });
  assert.equal(privacyRes.status, 200);
  const privacyBody = (await privacyRes.json()) as { counts: { observations: number } };
  assert.ok(privacyBody.counts.observations > 0);

  // --- Item 10 evidence, part 2: export is complete ---
  const exportRes = await fetch(`${baseUrl}/api/export`, { headers: { cookie } });
  assert.equal(exportRes.status, 200);
  const exportBody = (await exportRes.json()) as {
    account: { id: string };
    observations: unknown[];
    inboxEvents: unknown[];
    weeklyReviews: { id: string }[];
  };
  assert.equal(exportBody.account.id, userId);
  // Compared against the DB directly (not re-derived arithmetic from
  // earlier in this test) — this is the same completeness property
  // test/views.test.ts already checks, so it just needs to be a correct,
  // independent count here, not a re-verification of that mechanism.
  const actualObservationRows = await db.select().from(observations).where(eq(observations.userId, userId));
  assert.equal(exportBody.observations.length, actualObservationRows.length);
  assert.equal(exportBody.inboxEvents.length, 3, "text + form + voice must all appear in the export");
  assert.ok(exportBody.weeklyReviews.some((r) => r.id === reviewBody.review.id));

  // --- Item 10 evidence, part 3: two-step deletion, cross-account
  // isolation not repeated here (already exhaustively covered by
  // test/accountDeletion.test.ts) ---
  const deleteReqRes = await fetch(`${baseUrl}/api/account/delete-request`, { method: "POST", headers: { cookie } });
  assert.equal(deleteReqRes.status, 201);
  const { token } = (await deleteReqRes.json()) as { token: string };

  const deleteConfirmRes = await fetch(`${baseUrl}/api/account/delete-confirm`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assert.equal(deleteConfirmRes.status, 200);

  const [userRow] = await db.select().from(users).where(eq(users.id, userId));
  assert.equal(userRow, undefined, "the account must be fully gone after confirmed deletion");
  const remainingObs = await db.select().from(observations).where(eq(observations.userId, userId));
  assert.equal(remainingObs.length, 0, "cascade deletion must have removed this user's Observations");
  const remainingProfiles = await db.select().from(participantProfiles).where(eq(participantProfiles.userId, userId));
  assert.equal(remainingProfiles.length, 0);
});

// =====================================================================
// Multi-week gap: item 8 — "Missed days and weeks lead to a neutral
// recovery flow and do not create fabricated continuity."
// =====================================================================
test("multi-week gap: a 3+ week absence produces an honest, neutral recovery — never fabricated continuity", async () => {
  const authProviderId = `test-pkg12-gap-${suffix}`;
  const email = `pkg12-gap-${suffix}@test.local`;

  const [row] = await db
    .insert(users)
    .values({ email, authProvider: "replit", authProviderId, consentVersion: CURRENT_CONSENT_VERSION, consentAcceptedAt: new Date() })
    .returning();
  createdUserIds.push(row.id);
  const userId = row.id;

  const loginRes = await fetch(`${baseUrl}/api/_test/login-as`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ authProviderId, email }),
  });
  const cookie = extractCookie(loginRes);

  // Program started 22 days ago -> today falls in week index floor(22/7) = 3.
  // Zero Observations logged during the entire gap — a completely silent
  // account, the sharpest version of "missed days and weeks."
  const profileValues: Omit<ProfileInsert, "id" | "createdAt"> = {
    userId,
    version: 1,
    startingWeightValue: "170.0",
    startingWeightUnit: "lb",
    startingWeightDate: daysAgo(22),
    goals: [{ type: "weight-loss", description: "test goal" }],
    onWeightManagementMedication: false,
  };
  await db.insert(participantProfiles).values(profileValues);

  const reviewRes = await fetch(`${baseUrl}/api/program-weeks/current/generate-review`, { method: "POST", headers: { cookie } });
  assert.equal(reviewRes.status, 201);
  const reviewBody = (await reviewRes.json()) as {
    review: { structuredClaims: { proposedNextStep: { type: string; description: string } } };
  };
  assert.equal(
    reviewBody.review.structuredClaims.proposedNextStep.type,
    "insufficient-evidence",
    "a silent multi-week gap must produce an honest insufficient-evidence output, not fabricated progress"
  );

  const weeksRes = await fetch(`${baseUrl}/api/program-weeks`, { headers: { cookie } });
  const weeksBody = (await weeksRes.json()) as { programWeeks: { weekStartDate: string; status: string }[] };
  assert.equal(weeksBody.programWeeks.length, 4, "weeks 0 through 3 must all be honestly recorded — no gap silently absent");

  const sorted = [...weeksBody.programWeeks].sort((a, b) => a.weekStartDate.localeCompare(b.weekStartDate));
  for (let i = 0; i < 3; i++) {
    assert.equal(sorted[i].status, "skipped", `week index ${i} must be neutrally marked skipped, not fabricated as completed or in-progress`);
  }
  assert.notEqual(sorted[3].status, "skipped", "the current week itself is not retroactively skipped");
});
