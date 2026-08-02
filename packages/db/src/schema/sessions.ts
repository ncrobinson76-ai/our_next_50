import { index, json, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";

// sessions: not a PRD Section 12 entity — infrastructure required by
// connect-pg-simple (the Postgres-backed express-session store used in
// packages/api) to persist login sessions. Shape and column names
// (sid/sess/expire) are exactly what connect-pg-simple expects; it's
// configured with createTableIfMissing: false and manages rows in this
// table itself, so app code never queries it directly.
export const sessions = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: json("sess").notNull(),
    expire: timestamp("expire", { precision: 6 }).notNull(),
  },
  (table) => [index("sessions_expire_idx").on(table.expire)]
);
