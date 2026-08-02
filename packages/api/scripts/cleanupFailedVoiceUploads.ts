import * as dotenv from "dotenv";
dotenv.config();

import { and, eq, lt } from "drizzle-orm";
import { db, inboxEvents, sourceArtifacts } from "../src/db";
import { getAudioStorage } from "../src/voice/storage";

// Manual/cron cleanup for audio retained after a failed transcription
// (INB-04) — a real job scheduler is future infrastructure; this is a
// script a human runs periodically, or a documented cron entry invokes
// (suggested: once a day). See README.md's "Voice channel" section for
// the retention rules this enforces.
//
// This runs outside any request, so it deliberately uses `db` directly
// rather than req.data/scopedDataAccess. ACC-02's scoping exists to keep
// a single HTTP request from touching another user's rows; this is an
// offline maintenance job that spans all users by design — the boundary
// that keeps it safe is "only run manually/via cron," not per-user
// scoping, since there is no per-user request here to scope to.
const EXPIRY_HOURS = 48;

async function main(): Promise<void> {
  const cutoff = new Date(Date.now() - EXPIRY_HOURS * 60 * 60 * 1000);

  const expiredEvents = await db
    .select()
    .from(inboxEvents)
    .where(and(eq(inboxEvents.status, "transcription_failed"), lt(inboxEvents.createdAt, cutoff)));

  if (expiredEvents.length === 0) {
    console.log(`No transcription_failed audio older than ${EXPIRY_HOURS}h found.`);
    return;
  }

  const storage = getAudioStorage();
  let deletedCount = 0;

  for (const event of expiredEvents) {
    const artifacts = await db
      .select()
      .from(sourceArtifacts)
      .where(and(eq(sourceArtifacts.inboxEventId, event.id), eq(sourceArtifacts.retentionState, "active")));

    for (const artifact of artifacts) {
      try {
        await storage.delete(artifact.storageRef);
        await db
          .update(sourceArtifacts)
          .set({ retentionState: "deleted" })
          .where(eq(sourceArtifacts.id, artifact.id));
        deletedCount++;
        console.log(`Deleted expired audio for InboxEvent ${event.id} (SourceArtifact ${artifact.id}).`);
      } catch (err) {
        console.error(
          `Failed to delete audio for SourceArtifact ${artifact.id}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  console.log(`Done. Deleted ${deletedCount} expired audio file(s) across ${expiredEvents.length} failed InboxEvent(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Cleanup script failed:", err);
    process.exit(1);
  });
