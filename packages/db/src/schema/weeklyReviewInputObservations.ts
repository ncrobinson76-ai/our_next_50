import { pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { observations } from "./observations";
import { weeklyReviews } from "./weeklyReviews";

// Junction table: which Observations were part of a WeeklyReview's input
// snapshot (a review typically draws on many observations, so this is a
// many-to-many relationship rather than a single FK column).
export const weeklyReviewInputObservations = pgTable(
  "weekly_review_input_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    weeklyReviewId: uuid("weekly_review_id")
      .notNull()
      .references(() => weeklyReviews.id, { onDelete: "cascade" }),
    observationId: uuid("observation_id")
      .notNull()
      .references(() => observations.id, { onDelete: "cascade" }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("weekly_review_input_observations_pair_idx").on(
      table.weeklyReviewId,
      table.observationId
    ),
  ]
);
