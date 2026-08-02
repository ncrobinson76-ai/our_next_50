import * as crypto from "crypto";
import { eq } from "drizzle-orm";
import { db, users } from "../db";
import type { ScopedDataAccess } from "../data/scopedDataAccess";
import { getAudioStorage } from "../voice/storage";

// Package 11 Part D: two-step account deletion. POST /api/account/delete-
// request generates a token here and returns it to the caller exactly
// once — only its SHA-256 hash is ever persisted, so a database read
// alone (a backup, a compromised replica, a careless log) can't be
// replayed into a real deletion. POST /api/account/delete-confirm must
// present that same raw token within a short window.
const DELETION_TOKEN_TTL_MINUTES = 15;

function generateRawToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

function hashToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

function tokensMatch(providedHash: string, storedHash: string): boolean {
  const a = Buffer.from(providedHash, "hex");
  const b = Buffer.from(storedHash, "hex");
  // Different lengths would throw in timingSafeEqual — treat as a
  // mismatch rather than letting that distinguish valid-length-wrong-value
  // from invalid-length inputs.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export interface DeletionRequestResult {
  token: string;
  expiresAt: Date;
}

export async function createDeletionRequest(data: ScopedDataAccess): Promise<DeletionRequestResult> {
  const rawToken = generateRawToken();
  const expiresAt = new Date(Date.now() + DELETION_TOKEN_TTL_MINUTES * 60 * 1000);

  await data.accountDeletionRequests.create({
    tokenHash: hashToken(rawToken),
    expiresAt,
  });

  return { token: rawToken, expiresAt };
}

export type DeletionConfirmResult =
  | { ok: true }
  | { ok: false; reason: "no_pending_request" }
  | { ok: false; reason: "invalid_or_expired_token" }
  | { ok: false; reason: "storage_deletion_failed"; message: string };

/**
 * Validates the token against the most recent unexpired deletion request,
 * then performs the deletion: object-storage files are removed BEFORE the
 * DB row is touched (so a storage failure leaves everything retryable,
 * rather than a half-deleted account with orphaned files), then the
 * `users` row is deleted directly — every user-owned table cascades per
 * packages/db's schema, except SafetyEvents (anonymized via ON DELETE SET
 * NULL, a deliberate Package 11 decision — see safetyEvents.ts and
 * /OPERATIONS.md) and AuditEvents (same SET NULL pattern, pre-existing).
 */
export async function confirmDeletion(
  data: ScopedDataAccess,
  userId: string,
  rawToken: string
): Promise<DeletionConfirmResult> {
  const requests = await data.accountDeletionRequests.list();
  const now = Date.now();
  const pending = requests
    .filter((r) => r.expiresAt.getTime() > now)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  if (pending.length === 0) {
    return { ok: false, reason: "no_pending_request" };
  }

  const latest = pending[0];
  if (!tokensMatch(hashToken(rawToken), latest.tokenHash)) {
    return { ok: false, reason: "invalid_or_expired_token" };
  }

  const artifacts = await data.sourceArtifacts.list();
  const toDelete = artifacts.filter((a) => a.retentionState !== "deleted");
  const storage = getAudioStorage();
  try {
    for (const artifact of toDelete) {
      await storage.delete(artifact.storageRef);
    }
  } catch (err) {
    return {
      ok: false,
      reason: "storage_deletion_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  // users has no ScopedDataAccess accessor (it's the scope root itself,
  // not a user-owned table) — same direct-db exception
  // middleware/resolveAppUser.ts already establishes for this one table.
  await db.delete(users).where(eq(users.id, userId));

  return { ok: true };
}
