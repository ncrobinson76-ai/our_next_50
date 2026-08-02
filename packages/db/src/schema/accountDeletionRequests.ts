import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";

// AccountDeletionRequest: Package 11's two-step deletion confirmation.
// POST /api/account/delete-request creates a row here and returns a raw
// token to the caller exactly once; only its SHA-256 hash is stored, never
// the raw token itself, so a read of this table alone can't be replayed
// into a deletion. POST /api/account/delete-confirm looks up the user's
// most recent unexpired row and compares the hash. Deliberately CASCADEs
// on user delete (unlike safetyEvents/auditEvents) — this is ephemeral
// request state with no purpose once the account it refers to is gone.
export const accountDeletionRequests = pgTable(
  "account_deletion_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("account_deletion_requests_user_id_idx").on(table.userId)]
);
