import { index, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { safetyPolicyCategoryEnum, safetyResolutionStatusEnum } from "./enums";
import { inboxEvents } from "./inboxEvents";
import { observations } from "./observations";
import { users } from "./users";

// SafetyEvent: a safety-pathway trigger (see packages/eval-harness/safetyCheck.ts
// for the current rule-based detector this models). Per PRD Section 11, this
// table deliberately minimizes sensitive free-text content — it stores a
// category, a pathway key, and references to the triggering record, not a
// copy of the transcript or reflection text itself.
export const safetyEvents = pgTable(
  "safety_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    policyCategory: safetyPolicyCategoryEnum("policy_category").notNull(),
    triageConfidence: real("triage_confidence"),

    // Which fixed safety-pathway response was shown (a key, not the message text).
    pathwayKey: text("pathway_key").notNull(),
    systemVersion: text("system_version").notNull(),

    // References, not copies — see table comment above.
    sourceObservationId: uuid("source_observation_id").references(() => observations.id, {
      onDelete: "set null",
    }),
    sourceInboxEventId: uuid("source_inbox_event_id").references(() => inboxEvents.id, {
      onDelete: "set null",
    }),

    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionStatus: safetyResolutionStatusEnum("resolution_status").notNull().default("open"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("safety_events_user_id_idx").on(table.userId),
    index("safety_events_policy_category_idx").on(table.policyCategory),
    index("safety_events_resolution_status_idx").on(table.resolutionStatus),
  ]
);
