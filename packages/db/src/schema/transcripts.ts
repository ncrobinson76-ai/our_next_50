import { index, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sourceArtifacts } from "./sourceArtifacts";
import { users } from "./users";

// Transcript: speech-to-text output for a SourceArtifact.
export const transcripts = pgTable(
  "transcripts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceArtifactId: uuid("source_artifact_id")
      .notNull()
      .references(() => sourceArtifacts.id, { onDelete: "cascade" }),

    modelName: text("model_name").notNull(),
    modelVersion: text("model_version"),
    confidence: real("confidence"),

    text: text("text").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("transcripts_user_id_idx").on(table.userId),
    index("transcripts_source_artifact_id_idx").on(table.sourceArtifactId),
  ]
);
