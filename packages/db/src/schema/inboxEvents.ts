import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { inboxChannelEnum, inboxStatusEnum } from "./enums";
import { users } from "./users";

// InboxEvent: one incoming user interaction (voice call, text message, form
// submission — channel is extensible for future messaging/call integrations).
export const inboxEvents = pgTable(
  "inbox_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    channel: inboxChannelEnum("channel").notNull(),
    status: inboxStatusEnum("status").notNull().default("received"),

    // Finer-grained pipeline state than `status` (e.g. "awaiting_transcription"),
    // free-text since these will evolve faster than the coarse status enum.
    processingState: text("processing_state"),

    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),

    // Pointer to the raw payload in object storage — not the payload itself.
    rawPayloadRef: text("raw_payload_ref").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("inbox_events_user_id_idx").on(table.userId),
    index("inbox_events_status_idx").on(table.status),
  ]
);
