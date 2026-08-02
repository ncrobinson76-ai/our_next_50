import { Router } from "express";
import multer from "multer";
import { toInboxEventResponse } from "../inbox/mapping";
import { runPipeline } from "../inbox/pipeline";
import { transcribeAudio } from "../voice/transcription";
import { getAudioStorage } from "../voice/storage";

// Package 6: the voice channel, extending — not replacing — the text/form
// pipeline (Package 4/5). This file's only job is turning an audio upload
// into the same { text: string } payload shape text already uses, then
// handing off to the UNMODIFIED runPipeline() from pipeline.ts. There is
// no voice-specific branch in that shared pipeline — see its
// payloadToText() comment.
export const voiceRouter = Router();

const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25MB — generous for a voice note, not for raw video
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_AUDIO_BYTES } });

function isTruthyFlag(value: unknown): boolean {
  return typeof value === "string" && value.toLowerCase() === "true";
}

voiceRouter.post(
  "/api/inbox/voice",
  // multer errors (e.g. file too large) get a proper 400 here rather than
  // falling through to app.ts's generic 500 handler — an oversized upload
  // is an expected user error, not a server bug.
  (req, res, next) => {
    upload.single("audio")(req, res, (err: unknown) => {
      if (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(400).json({ error: "validation_failed", errors: [message] });
        return;
      }
      next();
    });
  },
  async (req, res) => {
    if (!req.data) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: "validation_failed", errors: ["an 'audio' file is required"] });
      return;
    }

    const keep = isTruthyFlag(req.body?.keep);

    // Lifecycle: received (upload landed) -> processing (transcription in
    // flight) -> processed/safety_flagged/needs_followup (from the shared
    // pipeline) or transcription_failed (distinct from those, INB-02).
    //
    // Insert values are assigned to variables rather than passed as
    // inline literals throughout this handler: Drizzle's InferInsertModel
    // is an intersection of "required"/"optional" column types, and TS's
    // excess-property check doesn't resolve cleanly through Omit<> over
    // that shape when given an object literal directly (same issue as
    // routes/inbox.ts and routes/participantProfiles.ts). Not a safety
    // concern either way.
    const inboxEventInsert = { channel: "voice" as const, status: "received" as const };
    const inboxEvent = await req.data.inboxEvents.create(inboxEventInsert);

    const objectKey = `voice/${inboxEvent.userId}/${inboxEvent.id}`;
    await getAudioStorage().upload(objectKey, req.file.buffer);

    const sourceArtifactInsert = {
      inboxEventId: inboxEvent.id,
      artifactType: "audio",
      mimeType: req.file.mimetype,
      fileSizeBytes: req.file.size,
      storageRef: objectKey,
      retentionState: "active" as const,
    };
    const sourceArtifact = await req.data.sourceArtifacts.create(sourceArtifactInsert);

    await req.data.inboxEvents.update(inboxEvent.id, { status: "processing" });

    let transcription: { text: string; confidence: number | null; modelName: string; modelVersion: string | null };
    try {
      // TEST-ONLY escape hatch, gated to NODE_ENV === "test", same pattern
      // as routes/testAuth.ts: lets the parity/retention test suite
      // control the transcription outcome per-request without live
      // Deepgram calls, while everything downstream (Transcript write,
      // payload update, runPipeline) is the exact real code path.
      if (process.env.NODE_ENV === "test" && req.body?.mockTranscriptFailure === "true") {
        throw new Error("mock transcription failure");
      }
      if (process.env.NODE_ENV === "test" && typeof req.body?.mockTranscriptText === "string") {
        transcription = {
          text: req.body.mockTranscriptText,
          confidence: 1,
          modelName: "mock",
          modelVersion: "test",
        };
      } else {
        transcription = await transcribeAudio(req.file.buffer, req.file.mimetype);
      }
    } catch (err) {
      await req.data.inboxEvents.update(inboxEvent.id, { status: "transcription_failed" });
      // Per INB-04: retained briefly for retry, not deleted immediately —
      // see scripts/cleanupFailedVoiceUploads.ts for the expiry.
      const updated = await req.data.inboxEvents.findById(inboxEvent.id);
      res.json({
        status: "transcription_failed",
        message: err instanceof Error ? err.message : String(err),
        inboxEvent: updated ? toInboxEventResponse(updated) : undefined,
      });
      return;
    }

    const transcriptInsert = {
      sourceArtifactId: sourceArtifact.id,
      modelName: transcription.modelName,
      modelVersion: transcription.modelVersion,
      confidence: transcription.confidence,
      text: transcription.text,
    };
    await req.data.transcripts.create(transcriptInsert);

    const withTranscript = await req.data.inboxEvents.update(inboxEvent.id, {
      payload: { text: transcription.text },
    });

    // The exact same, unmodified pipeline text/form already go through.
    const result = await runPipeline(req.data, withTranscript!);

    // INB-04: delete by default once processing has completed, regardless
    // of the pipeline's outcome (safety_flagged/needs_followup/processed
    // all count as "successfully processed" — the audio has served its
    // purpose once transcribed). The "keep" opt-in skips this.
    if (!keep) {
      await getAudioStorage().delete(objectKey);
      await req.data.sourceArtifacts.update(sourceArtifact.id, { retentionState: "deleted" });
    }

    const finalEvent = await req.data.inboxEvents.findById(inboxEvent.id);
    res.json({ ...result, inboxEvent: finalEvent ? toInboxEventResponse(finalEvent) : undefined });
  }
);

// Never a public URL — ownership is checked via the InboxEvent's userId
// before storage is ever touched, same as every other route in this
// codebase (ACC-02). B requesting A's audio 404s here, same as any other
// cross-account attempt.
voiceRouter.get("/api/inbox/:id/audio", async (req, res) => {
  if (!req.data) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  const event = await req.data.inboxEvents.findById(req.params.id);
  if (!event) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const artifacts = await req.data.sourceArtifacts.list();
  const artifact = artifacts.find((a) => a.inboxEventId === event.id);
  if (!artifact || artifact.retentionState === "deleted") {
    res.status(410).json({ error: "audio_unavailable", message: "This audio is no longer retained." });
    return;
  }

  const bytes = await getAudioStorage().download(artifact.storageRef);
  res.setHeader("Content-Type", artifact.mimeType ?? "application/octet-stream");
  res.send(bytes);
});
