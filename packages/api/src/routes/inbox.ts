import express, { Router } from "express";
import { toInboxEventResponse } from "../inbox/mapping";
import { parseFormPayload, parseTextPayload } from "../inbox/validation";
import { runPipeline } from "../inbox/pipeline";

// INB-01 (Package 4): text and form submissions must produce the exact
// same canonical InboxEvent shape. The two POST routes below insert
// through the identical req.data.inboxEvents.create() call, differing
// only in `channel` and what goes into `payload` — never in a separate
// code path or a different set of top-level columns. If that ever
// diverges, it's a bug (see test/inbox.test.ts's structural-symmetry
// test).
//
// Package 5 adds the extraction pipeline (PRD Section 9/10): POST
// /:id/process and /:id/follow-up-answer, both synchronous — there is no
// background job queue in this package. A real queue is future
// infrastructure; see README.md.
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

inboxRouter.post("/api/inbox/:id/process", async (req, res) => {
  if (!req.data) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  const event = await req.data.inboxEvents.findById(req.params.id);
  if (!event) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (event.status !== "received") {
    res.status(409).json({ error: "already_processed", status: event.status });
    return;
  }

  const result = await runPipeline(req.data, event);
  const updated = await req.data.inboxEvents.findById(event.id);
  res.json({ ...result, inboxEvent: updated ? toInboxEventResponse(updated) : undefined });
});

inboxRouter.post("/api/inbox/:id/follow-up-answer", express.json(), async (req, res) => {
  if (!req.data) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  const event = await req.data.inboxEvents.findById(req.params.id);
  if (!event) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (event.status !== "needs_followup") {
    res.status(409).json({ error: "no_pending_follow_up", status: event.status });
    return;
  }

  const answer = req.body?.answer;
  if (typeof answer !== "string" || answer.trim().length === 0) {
    res.status(400).json({ error: "validation_failed", errors: ["answer is required and must be a non-empty string"] });
    return;
  }

  const result = await runPipeline(req.data, event, answer);
  const updated = await req.data.inboxEvents.findById(event.id);
  res.json({ ...result, inboxEvent: updated ? toInboxEventResponse(updated) : undefined });
});
