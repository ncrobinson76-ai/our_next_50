import { and, eq, type InferInsertModel, type InferSelectModel } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { db, inboxEvents, participantProfiles } from "../db";

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

export interface ScopedDataAccess {
  participantProfiles: ReturnType<typeof createScopedTableAccess<typeof participantProfiles>>;
  inboxEvents: ReturnType<typeof createScopedTableAccess<typeof inboxEvents>>;
}

export function createScopedDataAccess(userId: string): ScopedDataAccess {
  return {
    participantProfiles: createScopedTableAccess(participantProfiles, userId),
    inboxEvents: createScopedTableAccess(inboxEvents, userId),
  };
}
