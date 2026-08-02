import { bigint, index, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { retentionStateEnum } from "./enums";
import { inboxEvents } from "./inboxEvents";
import { users } from "./users";

// SourceArtifact: audio/attachment metadata for an InboxEvent. Stores a
// pointer to the actual blob in storage, not the blob itself.
export const sourceArtifacts = pgTable(
  "source_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    inboxEventId: uuid("inbox_event_id")
      .notNull()
      .references(() => inboxEvents.id, { onDelete: "cascade" }),

    artifactType: text("artifact_type").notNull(),
    mimeType: text("mime_type"),
    durationSeconds: numeric("duration_seconds", { precision: 8, scale: 2 }),
    fileSizeBytes: bigint("file_size_bytes", { mode: "number" }),

    storageRef: text("storage_ref").notNull(),
    retentionState: retentionStateEnum("retention_state").notNull().default("active"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("source_artifacts_user_id_idx").on(table.userId),
    index("source_artifacts_inbox_event_id_idx").on(table.inboxEventId),
  ]
);
