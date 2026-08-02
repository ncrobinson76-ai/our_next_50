// INB-01: text and form submissions must produce the exact same canonical
// InboxEvent shape. The two payload shapes below are the ONLY thing that
// varies by channel — everything else (top-level columns: id, channel,
// status, receivedAt, createdAt, ...) is identical regardless of which of
// these two types populated `payload`. See routes/inbox.ts and
// test/inbox.test.ts's structural-symmetry test.

export interface TextPayload {
  text: string;
}

export type WeightUnit = "lb" | "kg";

// The "one-minute structured check-in" (PRD Section 13). Deliberately
// minimal — every field optional individually, but the submission as a
// whole must carry at least one. A user who wants to say more than this
// should use the text channel instead.
export interface FormPayload {
  weight?: { value: number; unit: WeightUnit };
  hungerLevel?: number; // 1-5
  note?: string;
}
