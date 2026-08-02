import { and, eq, type InferInsertModel, type InferSelectModel } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import {
  db,
  experimentCompletionObservations,
  experiments,
  inboxEvents,
  observations,
  participantProfiles,
  programWeeks,
  safetyEvents,
  sourceArtifacts,
  transcripts,
  weeklyReviewInputObservations,
  weeklyReviews,
} from "../db";

// ACC-02, the core pattern: every user-owned table (anything with a
// userId column — observations, inboxEvents, participantProfiles, and
// everything future packages add) must be queried through a
// ScopedTableAccess instance, never through `db` directly. Route handlers
// are only ever handed `req.data` (see middleware/attachScopedData.ts) —
// they never get a reference to the raw `db`/table objects at all, so
// there is no code path by which a handler could "forget" the userId
// filter. Extend this file (add one line to createScopedDataAccess) for
// every new user-owned table a future package introduces; do not query
// those tables anywhere else in the codebase.
//
// Note on typing: Drizzle's query builder generics don't resolve cleanly
// through a table passed in as a bounded generic parameter, so the calls
// into `db` below go through a loosely-typed `t` alias. That's purely a
// TypeScript inference limitation — the actual safety boundary is the
// `eq`/`and` userId filter below, which is fully real and always applied;
// nothing here weakens it. The public methods stay typed against the
// caller's real row shape via InferSelectModel/InferInsertModel.

type UserOwnedTable = PgTable & {
  id: AnyPgColumn;
  userId: AnyPgColumn;
};

function createScopedTableAccess<T extends UserOwnedTable>(table: T, userId: string) {
  const t = table as PgTable & { id: AnyPgColumn; userId: AnyPgColumn };
  type Row = InferSelectModel<T>;
  type InsertValues = InferInsertModel<T>;

  return {
    async list(): Promise<Row[]> {
      return (await db.select().from(t).where(eq(t.userId, userId))) as Row[];
    },

    async findById(id: string): Promise<Row | null> {
      const rows = await db
        .select()
        .from(t)
        .where(and(eq(t.id, id), eq(t.userId, userId)));
      return (rows[0] as Row) ?? null;
    },

    async create(values: Omit<InsertValues, "userId">): Promise<Row> {
      const rows = await db
        .insert(t)
        .values({ ...values, userId } as Record<string, unknown>)
        .returning();
      return rows[0] as Row;
    },

    async update(id: string, patch: Partial<InsertValues>): Promise<Row | null> {
      const rows = await db
        .update(t)
        .set(patch as Record<string, unknown>)
        .where(and(eq(t.id, id), eq(t.userId, userId)))
        .returning();
      return (rows[0] as Row) ?? null;
    },

    async remove(id: string): Promise<Row | null> {
      const rows = await db
        .delete(t)
        .where(and(eq(t.id, id), eq(t.userId, userId)))
        .returning();
      return (rows[0] as Row) ?? null;
    },
  };
}

// weeklyReviewInputObservations is a many-to-many junction table (which
// Observations fed a given WeeklyReview) with no userId column of its own,
// so it can't go through createScopedTableAccess's UserOwnedTable
// constraint. Every method here re-derives the scoping guarantee by joining
// back to weeklyReviews.userId instead — a route handler still never gets a
// path to this table that skips the userId check, it's just checked via a
// join rather than a direct column, since this junction row has no owner of
// its own except through the WeeklyReview it belongs to.
export interface WeeklyReviewInputObservationsAccess {
  createMany(weeklyReviewId: string, observationIds: string[]): Promise<void>;
  listObservationIds(weeklyReviewId: string): Promise<string[]>;
}

function createWeeklyReviewInputObservationsAccess(userId: string): WeeklyReviewInputObservationsAccess {
  return {
    async createMany(weeklyReviewId, observationIds) {
      if (observationIds.length === 0) return;
      const [owned] = await db
        .select({ id: weeklyReviews.id })
        .from(weeklyReviews)
        .where(and(eq(weeklyReviews.id, weeklyReviewId), eq(weeklyReviews.userId, userId)));
      if (!owned) throw new Error("weeklyReviewId does not belong to this user");
      await db
        .insert(weeklyReviewInputObservations)
        .values(observationIds.map((observationId) => ({ weeklyReviewId, observationId })));
    },

    async listObservationIds(weeklyReviewId) {
      const rows = await db
        .select({ observationId: weeklyReviewInputObservations.observationId })
        .from(weeklyReviewInputObservations)
        .innerJoin(weeklyReviews, eq(weeklyReviewInputObservations.weeklyReviewId, weeklyReviews.id))
        .where(and(eq(weeklyReviewInputObservations.weeklyReviewId, weeklyReviewId), eq(weeklyReviews.userId, userId)));
      return rows.map((row) => row.observationId);
    },
  };
}

// experimentCompletionObservations is the same shape of problem as
// weeklyReviewInputObservations above (many-to-many junction, no userId
// column of its own) — same fix: every method re-derives the scoping
// guarantee by joining back to experiments.userId.
export interface ExperimentCompletionObservationsAccess {
  createLink(experimentId: string, observationId: string): Promise<void>;
  listObservationIds(experimentId: string): Promise<string[]>;
}

function createExperimentCompletionObservationsAccess(userId: string): ExperimentCompletionObservationsAccess {
  return {
    async createLink(experimentId, observationId) {
      const [owned] = await db
        .select({ id: experiments.id })
        .from(experiments)
        .where(and(eq(experiments.id, experimentId), eq(experiments.userId, userId)));
      if (!owned) throw new Error("experimentId does not belong to this user");
      await db.insert(experimentCompletionObservations).values({ experimentId, observationId });
    },

    async listObservationIds(experimentId) {
      const rows = await db
        .select({ observationId: experimentCompletionObservations.observationId })
        .from(experimentCompletionObservations)
        .innerJoin(experiments, eq(experimentCompletionObservations.experimentId, experiments.id))
        .where(and(eq(experimentCompletionObservations.experimentId, experimentId), eq(experiments.userId, userId)));
      return rows.map((row) => row.observationId);
    },
  };
}

export interface ScopedDataAccess {
  participantProfiles: ReturnType<typeof createScopedTableAccess<typeof participantProfiles>>;
  inboxEvents: ReturnType<typeof createScopedTableAccess<typeof inboxEvents>>;
  observations: ReturnType<typeof createScopedTableAccess<typeof observations>>;
  safetyEvents: ReturnType<typeof createScopedTableAccess<typeof safetyEvents>>;
  sourceArtifacts: ReturnType<typeof createScopedTableAccess<typeof sourceArtifacts>>;
  transcripts: ReturnType<typeof createScopedTableAccess<typeof transcripts>>;
  programWeeks: ReturnType<typeof createScopedTableAccess<typeof programWeeks>>;
  weeklyReviews: ReturnType<typeof createScopedTableAccess<typeof weeklyReviews>>;
  weeklyReviewInputObservations: WeeklyReviewInputObservationsAccess;
  experiments: ReturnType<typeof createScopedTableAccess<typeof experiments>>;
  experimentCompletionObservations: ExperimentCompletionObservationsAccess;
}

export function createScopedDataAccess(userId: string): ScopedDataAccess {
  return {
    participantProfiles: createScopedTableAccess(participantProfiles, userId),
    inboxEvents: createScopedTableAccess(inboxEvents, userId),
    observations: createScopedTableAccess(observations, userId),
    safetyEvents: createScopedTableAccess(safetyEvents, userId),
    sourceArtifacts: createScopedTableAccess(sourceArtifacts, userId),
    transcripts: createScopedTableAccess(transcripts, userId),
    programWeeks: createScopedTableAccess(programWeeks, userId),
    weeklyReviews: createScopedTableAccess(weeklyReviews, userId),
    weeklyReviewInputObservations: createWeeklyReviewInputObservationsAccess(userId),
    experiments: createScopedTableAccess(experiments, userId),
    experimentCompletionObservations: createExperimentCompletionObservationsAccess(userId),
  };
}
