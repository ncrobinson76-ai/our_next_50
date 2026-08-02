import { boolean, date, index, integer, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { programWeekStatusEnum } from "./enums";
import { observations } from "./observations";
import { users } from "./users";

// ProgramWeek: one calendar week of a user's program.
export const programWeeks = pgTable(
  "program_weeks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    weekStartDate: date("week_start_date").notNull(),
    weekEndDate: date("week_end_date").notNull(),

    // The Nth completed week for this user (1-indexed).
    completedWeekNumber: integer("completed_week_number"),

    evidenceSufficient: boolean("evidence_sufficient").notNull().default(false),

    // The user's free-text weekly reflection, captured as an Observation of
    // type "context_reflection" — linked here rather than duplicated.
    reflectionObservationId: uuid("reflection_observation_id").references(() => observations.id, {
      onDelete: "set null",
    }),

    status: programWeekStatusEnum("status").notNull().default("scheduled"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("program_weeks_user_week_start_idx").on(table.userId, table.weekStartDate),
    index("program_weeks_user_id_idx").on(table.userId),
  ]
);
