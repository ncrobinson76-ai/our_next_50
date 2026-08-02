import { AnyPgColumn, boolean, date, index, jsonb, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { confidenceLevelEnum, observationTypeEnum, timeOfDayEnum, verificationStateEnum } from "./enums";
import { inboxEvents } from "./inboxEvents";
import { transcripts } from "./transcripts";
import { users } from "./users";

// Observation: the single most important table in this schema. One row per
// logged data point (weight, waist, sleep, meal, hunger, energy, activity,
// experiment completion, context/reflection, symptom/safety-relevant, or
// non-scale win). Deliberately wide/polymorphic: `value`/`unit` hold the
// primary scalar when one exists (weight, sleep hours, hunger level, ...),
// `textValue` holds free-text content (meal description, reflection,
// symptom description, non-scale win), and `structuredDetails` holds any
// type-specific extra structure (e.g. a meal's approxCalories, an
// activity's intensity/duration).
export const observations = pgTable(
  "observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    type: observationTypeEnum("type").notNull(),
    observedDate: date("observed_date").notNull(),
    timeOfDay: timeOfDayEnum("time_of_day"),

    value: numeric("value", { precision: 10, scale: 3 }),
    unit: text("unit"),
    textValue: text("text_value"),
    structuredDetails: jsonb("structured_details"),

    confidenceLevel: confidenceLevelEnum("confidence_level").notNull().default("user_reported"),
    verificationState: verificationStateEnum("verification_state").notNull().default("proposed"),

    // Provenance: which InboxEvent/Transcript this observation came from, if
    // any (e.g. a manually-entered form observation may have neither).
    // SET NULL rather than CASCADE — purging a raw inbox payload or
    // transcript per retention policy must never delete the durable
    // observation record derived from it.
    sourceInboxEventId: uuid("source_inbox_event_id").references(() => inboxEvents.id, {
      onDelete: "set null",
    }),
    sourceTranscriptId: uuid("source_transcript_id").references(() => transcripts.id, {
      onDelete: "set null",
    }),

    // Supersession: correcting an observation never deletes the old row.
    // Instead, insert a new row whose supersedesObservationId points back
    // to the old one, and mark the old row isSuperseded = true. Both fields
    // are maintained by the application in the same transaction — there is
    // no DB trigger enforcing this.
    isSuperseded: boolean("is_superseded").notNull().default(false),
    supersedesObservationId: uuid("supersedes_observation_id").references(
      (): AnyPgColumn => observations.id,
      { onDelete: "set null" }
    ),
    correctionReason: text("correction_reason"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("observations_user_id_idx").on(table.userId),
    index("observations_user_date_idx").on(table.userId, table.observedDate),
    index("observations_user_type_idx").on(table.userId, table.type),
    index("observations_is_superseded_idx").on(table.isSuperseded),
  ]
);
