// Package 6: the voice channel, extending — not replacing — Package 4/5's
// text/form pipeline. The core property under test is parity: a voice
// upload must flow through the exact same runPipeline() as an equivalent
// text entry, extending Package 4's structural-symmetry principle to this
// third channel.
//
// Transcription is stubbed via a test-only escape hatch in
// routes/voice.ts (mockTranscriptText / mockTranscriptFailure fields,
// gated to NODE_ENV === "test", same pattern as /api/_test/login-as) —
// everything downstream of "we have transcript text" (Transcript write,
// payload update, the shared pipeline, retention) is the real code path.
// Audio storage uses the local filesystem stub (src/voice/storage.ts),
// also gated to NODE_ENV === "test", since live Replit object storage
// isn't reachable from outside a Repl (same situation as Postgres/auth —
// see packages/db/README.md).
import * as dotenv from "dotenv";
dotenv.config();
process.env.NODE_ENV = "test";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { db, users, sourceArtifacts, observations, safetyEvents } from "../src/db";
import { CURRENT_CONSENT_VERSION } from "../src/consent";

let server: Server;
let baseUrl: string;

const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
const userA = { authProviderId: `test-voice-a-${suffix}`, email: `voice-a-${suffix}@test.local` };
const userB = { authProviderId: `test-voice-b-${suffix}`, email: `voice-b-${suffix}@test.local` };

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

interface VoiceUploadOptions {
  mockTranscriptText?: string;
  mockTranscriptFailure?: boolean;
  keep?: boolean;
  noFile?: boolean;
}

async function uploadVoice(cookie: string | undefined, opts: VoiceUploadOptions = {}): Promise<Response> {
  const form = new FormData();
  if (!opts.noFile) {
    const fakeAudioBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    form.append("audio", new Blob([fakeAudioBytes], { type: "audio/wav" }), "note.wav");
  }
  if (opts.mockTranscriptText !== undefined) form.append("mockTranscriptText", opts.mockTranscriptText);
  if (opts.mockTranscriptFailure) form.append("mockTranscriptFailure", "true");
  if (opts.keep) form.append("keep", "true");

  return fetch(`${baseUrl}/api/inbox/voice`, {
    method: "POST",
    headers: cookie ? { cookie } : undefined,
    body: form,
  });
}

interface ObservationLike {
  type: string;
  confidenceLevel: string;
  verificationState: string;
}

interface VoiceUploadResponse {
  status: string;
  pathwayMessage?: string;
  followUpQuestion?: string;
  observations?: ObservationLike[];
  inboxEvent: { id: string; status: string };
}

test("unauthenticated request to voice routes is rejected", async () => {
  const uploadRes = await uploadVoice(undefined, { mockTranscriptText: "irrelevant" });
  assert.equal(uploadRes.status, 401);

  const audioRes = await fetch(`${baseUrl}/api/inbox/00000000-0000-0000-0000-000000000000/audio`);
  assert.equal(audioRes.status, 401);
});

test("an upload with no file is rejected", async () => {
  const cookie = await loginAs(userA);
  const res = await uploadVoice(cookie, { noFile: true, mockTranscriptText: "x" });
  assert.equal(res.status, 400);
});

test(
  "voice parity: a mocked-transcript upload flows through the exact same pipeline as equivalent text",
  async () => {
    const cookie = await loginAs(userA);
    const equivalentText = "Weighed in at 172.4 lbs this morning. Felt pretty hungry around 3pm.";

    const voiceRes = await uploadVoice(cookie, { mockTranscriptText: equivalentText });
    assert.equal(voiceRes.status, 200);
    const voiceResult = (await voiceRes.json()) as VoiceUploadResponse;

    const textCreateRes = await fetch(`${baseUrl}/api/inbox/text`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ text: equivalentText }),
    });
    const textEvent = (await textCreateRes.json()) as { id: string };
    const textProcessRes = await fetch(`${baseUrl}/api/inbox/${textEvent.id}/process`, {
      method: "POST",
      headers: { cookie },
    });
    const textResult = (await textProcessRes.json()) as VoiceUploadResponse;

    assert.equal(voiceResult.status, textResult.status, "voice and text must reach the same pipeline outcome");

    if (voiceResult.status === "processed") {
      assert.ok(voiceResult.observations && voiceResult.observations.length > 0);
      assert.ok(textResult.observations && textResult.observations.length > 0);

      // Structural symmetry (Package 4's principle, extended to voice):
      // identical top-level Observation field set regardless of channel.
      assert.deepEqual(
        Object.keys(voiceResult.observations![0]).sort(),
        Object.keys(textResult.observations![0]).sort()
      );

      // Content parity: a precisely stated weight should be extracted as
      // "measured" from both, since both ultimately hand the identical
      // text string to the same extractObservations() call.
      const voiceWeight = voiceResult.observations!.find((o) => o.type === "weight");
      const textWeight = textResult.observations!.find((o) => o.type === "weight");
      assert.ok(voiceWeight, "voice channel should extract a weight observation");
      assert.ok(textWeight, "text channel should extract a weight observation");
      assert.equal(voiceWeight!.confidenceLevel, "measured");
      assert.equal(textWeight!.confidenceLevel, "measured");
      assert.equal(voiceWeight!.verificationState, "proposed");
    }
  }
);

test("default: audio is deleted after successful processing", async () => {
  const cookie = await loginAs(userA);
  const res = await uploadVoice(cookie, { mockTranscriptText: "slept about 7 hours last night" });
  assert.equal(res.status, 200);
  const result = (await res.json()) as VoiceUploadResponse;

  const audioRes = await fetch(`${baseUrl}/api/inbox/${result.inboxEvent.id}/audio`, { headers: { cookie } });
  assert.equal(audioRes.status, 410, "audio must be gone by default after processing");

  const artifacts = await db
    .select()
    .from(sourceArtifacts)
    .where(eq(sourceArtifacts.inboxEventId, result.inboxEvent.id));
  assert.equal(artifacts[0]?.retentionState, "deleted");
});

test("keep=true prevents deletion", async () => {
  const cookie = await loginAs(userA);
  const res = await uploadVoice(cookie, { mockTranscriptText: "quick note, nothing unusual", keep: true });
  assert.equal(res.status, 200);
  const result = (await res.json()) as VoiceUploadResponse;

  const audioRes = await fetch(`${baseUrl}/api/inbox/${result.inboxEvent.id}/audio`, { headers: { cookie } });
  assert.equal(audioRes.status, 200, "audio must still be retrievable when keep=true was requested");
  const bytes = Buffer.from(await audioRes.arrayBuffer());
  assert.ok(bytes.length > 0);

  const artifacts = await db
    .select()
    .from(sourceArtifacts)
    .where(eq(sourceArtifacts.inboxEventId, result.inboxEvent.id));
  assert.equal(artifacts[0]?.retentionState, "active");
});

test("a simulated transcription failure retains the audio and sets transcription_failed", async () => {
  const cookie = await loginAs(userA);
  const res = await uploadVoice(cookie, { mockTranscriptFailure: true });
  assert.equal(res.status, 200);
  const result = (await res.json()) as VoiceUploadResponse;

  assert.equal(result.status, "transcription_failed");
  assert.equal(result.inboxEvent.status, "transcription_failed");

  const audioRes = await fetch(`${baseUrl}/api/inbox/${result.inboxEvent.id}/audio`, { headers: { cookie } });
  assert.equal(audioRes.status, 200, "audio must still be retrievable after a failed transcription");

  const artifacts = await db
    .select()
    .from(sourceArtifacts)
    .where(eq(sourceArtifacts.inboxEventId, result.inboxEvent.id));
  assert.equal(artifacts[0]?.retentionState, "active", "failed-transcription audio is not deleted immediately");
});

test("a safety-flagged voice transcript short-circuits exactly like text (reusing Package 5's guarantee)", async () => {
  const cookie = await loginAs(userA);
  const res = await uploadVoice(cookie, {
    mockTranscriptText: "I've been thinking there's no point in any of this anymore.",
  });
  assert.equal(res.status, 200);
  const result = (await res.json()) as VoiceUploadResponse;

  assert.equal(result.status, "safety_flagged");
  assert.ok(result.pathwayMessage);
  assert.equal(result.inboxEvent.status, "safety_flagged");
  assert.equal(result.observations, undefined, "a flagged voice entry must produce zero Observations");

  const obsRows = await db
    .select()
    .from(observations)
    .where(eq(observations.sourceInboxEventId, result.inboxEvent.id));
  assert.equal(obsRows.length, 0);

  const safetyRows = await db
    .select()
    .from(safetyEvents)
    .where(eq(safetyEvents.sourceInboxEventId, result.inboxEvent.id));
  assert.equal(safetyRows.length, 1);
  assert.equal(safetyRows[0].policyCategory, "crisis_language");
});

test("cross-account isolation: B cannot fetch A's audio by guessing its InboxEvent id", async () => {
  const cookieA = await loginAs(userA);
  const cookieB = await loginAs(userB);

  const res = await uploadVoice(cookieA, { mockTranscriptText: "isolation test note", keep: true });
  assert.equal(res.status, 200);
  const result = (await res.json()) as VoiceUploadResponse;

  const crossAudioRes = await fetch(`${baseUrl}/api/inbox/${result.inboxEvent.id}/audio`, {
    headers: { cookie: cookieB },
  });
  assert.equal(crossAudioRes.status, 404, "B fetching A's audio must fail");

  const ownAudioRes = await fetch(`${baseUrl}/api/inbox/${result.inboxEvent.id}/audio`, {
    headers: { cookie: cookieA },
  });
  assert.equal(ownAudioRes.status, 200, "A must still be able to fetch their own audio");
});
