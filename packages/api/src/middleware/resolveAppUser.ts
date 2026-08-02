import type { RequestHandler } from "express";
import { and, eq } from "drizzle-orm";
import { db, users } from "../db";

const AUTH_PROVIDER = "replit";

interface PgUniqueViolation {
  code: string;
}

function isUniqueViolation(err: unknown): err is PgUniqueViolation {
  return typeof err === "object" && err !== null && (err as PgUniqueViolation).code === "23505";
}

// ACC-01: resolve every request to exactly one user row, derived only from
// the server-verified session (req.user.claims, set by replitAuth.ts) —
// never from anything the client could pass in a body/query/header. On a
// verified identity's first request, creates the users row (that's "first
// login" from this server's point of view).
export const resolveAppUser: RequestHandler = async (req, res, next) => {
  const claims = req.user?.claims;
  const authProviderId = claims?.sub;
  const email = claims?.email;

  if (!authProviderId || !email) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  try {
    const existingRows = await db
      .select()
      .from(users)
      .where(and(eq(users.authProvider, AUTH_PROVIDER), eq(users.authProviderId, authProviderId)));

    let row = existingRows[0];

    if (!row) {
      try {
        const inserted = await db
          .insert(users)
          .values({ email, authProvider: AUTH_PROVIDER, authProviderId })
          .returning();
        row = inserted[0];
      } catch (err) {
        // Two concurrent first requests for the same identity can both
        // reach here; the loser of the unique-constraint race just
        // re-fetches the row the winner created.
        if (!isUniqueViolation(err)) throw err;
        const rows = await db
          .select()
          .from(users)
          .where(and(eq(users.authProvider, AUTH_PROVIDER), eq(users.authProviderId, authProviderId)));
        row = rows[0];
      }
    } else if (row.email !== email) {
      const updated = await db.update(users).set({ email }).where(eq(users.id, row.id)).returning();
      row = updated[0];
    }

    if (!row) {
      res.status(500).json({ error: "internal_error" });
      return;
    }

    req.appUser = row;
    next();
  } catch (err) {
    next(err);
  }
};
