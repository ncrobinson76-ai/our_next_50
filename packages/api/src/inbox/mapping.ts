import type { InferSelectModel } from "drizzle-orm";
import type { inboxEvents } from "../db";

type InboxEventRow = InferSelectModel<typeof inboxEvents>;

// The canonical response shape — identical field set regardless of
// channel. Only what's inside `payload` differs (see inbox/types.ts).
export interface InboxEventResponse {
  id: string;
  channel: string;
  status: string;
  payload: unknown;
  receivedAt: Date;
  processedAt: Date | null;
  createdAt: Date;
}

export function toInboxEventResponse(row: InboxEventRow): InboxEventResponse {
  return {
    id: row.id,
    channel: row.channel,
    status: row.status,
    payload: row.payload,
    receivedAt: row.receivedAt,
    processedAt: row.processedAt,
    createdAt: row.createdAt,
  };
}
