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
//
// Package 11: userId uses ON DELETE SET NULL rather than CASCADE — the
// same deliberate exception auditEvents.ts already documents for
// actorUserId/subjectUserId — so a category+timestamp safety-incident
// record survives account deletion (anonymized, with no link back to the
// deleted user) rather than being erased along with everything else. This
// was an explicit product decision (not made unilaterally by whoever
// wrote this code), and per /OPERATIONS.md it's provisional pending the
// same pending attorney review that gates this app's rollout — a
// jurisdiction's own record-retention or mandatory-reporting rules could
// call for something different.
export const safetyEvents = pgTable(
  "safety_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),

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
