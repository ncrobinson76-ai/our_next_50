import { pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { experiments } from "./experiments";
import { observations } from "./observations";

// Junction table: which Observations (typically type = "experiment_completion")
// are check-ins/completion entries for a given Experiment.
export const experimentCompletionObservations = pgTable(
  "experiment_completion_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    experimentId: uuid("experiment_id")
      .notNull()
      .references(() => experiments.id, { onDelete: "cascade" }),
    observationId: uuid("observation_id")
      .notNull()
      .references(() => observations.id, { onDelete: "cascade" }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("experiment_completion_observations_pair_idx").on(
      table.experimentId,
      table.observationId
    ),
  ]
);
