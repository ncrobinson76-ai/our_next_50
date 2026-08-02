import express, { Router } from "express";
import { toInboxEventResponse } from "../inbox/mapping";
import { parseFormPayload, parseTextPayload } from "../inbox/validation";

// INB-01: text and form submissions must produce the exact same canonical
// InboxEvent shape. Both routes below insert through the identical
// req.data.inboxEvents.create() call, differing only in `channel` and
// what goes into `payload` — never in a separate code path or a different
// set of top-level columns. If that ever diverges, it's a bug (see
// test/inbox.test.ts's structural-symmetry test).
//
// This package's responsibility ends at "the raw submission is durably
// and correctly stored." No extraction into Observations here — that's
// Package 5's job — so every event is created with status "received" and
// left alone.
export const inboxRouter = Router();

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

inboxRouter.post("/api/inbox/text", express.json(), async (req, res) => {
  if (!req.data) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  const parsed = parseTextPayload(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: "validation_failed", errors: parsed.errors });
    return;
  }

  // Assigned to a variable rather than passed as an inline literal:
  // Drizzle's InferInsertModel is an intersection of "required" and
  // "optional" column types, and TS's excess-property check doesn't
  // resolve cleanly through Omit<> over that shape when given an object
  // literal directly. Not a safety concern either way — `create()` always
  // injects userId itself regardless of what's passed here.
  const insertValues = { channel: "text" as const, status: "received" as const, payload: parsed.value };
  const created = await req.data.inboxEvents.create(insertValues);
  res.status(201).json(toInboxEventResponse(created));
});

inboxRouter.post("/api/inbox/form", express.json(), async (req, res) => {
  if (!req.data) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  const parsed = parseFormPayload(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: "validation_failed", errors: parsed.errors });
    return;
  }

  const insertValues = { channel: "form" as const, status: "received" as const, payload: parsed.value };
  const created = await req.data.inboxEvents.create(insertValues);
  res.status(201).json(toInboxEventResponse(created));
});

inboxRouter.get("/api/inbox", async (req, res) => {
  if (!req.data) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  const rawLimit = Number(req.query.limit);
  const rawOffset = Number(req.query.offset);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIST_LIMIT) : DEFAULT_LIST_LIMIT;
  const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

  const rows = await req.data.inboxEvents.list();
  const sorted = [...rows].sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
  const page = sorted.slice(offset, offset + limit);

  res.json({
    events: page.map(toInboxEventResponse),
    total: rows.length,
    limit,
    offset,
  });
});
