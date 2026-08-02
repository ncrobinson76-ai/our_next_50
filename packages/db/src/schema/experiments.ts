import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { experimentDifficultyEnum, experimentStatusEnum } from "./enums";
import { users } from "./users";
import { weeklyReviews } from "./weeklyReviews";

// Experiment: a proposed behavior change, typically originating from a
// WeeklyReview's proposedNextStep. Which Observations count as completion
// check-ins is captured by the experimentCompletionObservations junction
// table (see experimentCompletionObservations.ts).
export const experiments = pgTable(
  "experiments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    weeklyReviewId: uuid("weekly_review_id").references(() => weeklyReviews.id, {
      onDelete: "set null",
    }),

    recommendation: text("recommendation").notNull(),
    rationale: text("rationale").notNull(),
    unchangedBehaviors: text("unchanged_behaviors").array().notNull().default([]),
    target: text("target"),
    difficulty: experimentDifficultyEnum("difficulty"),
    status: experimentStatusEnum("status").notNull().default("proposed"),

    startedAt: timestamp("started_at", { withTimezone: true }),
    outcome: text("outcome"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("experiments_user_id_idx").on(table.userId),
    index("experiments_status_idx").on(table.status),
    index("experiments_weekly_review_id_idx").on(table.weeklyReviewId),
  ]
);
