import { Router } from "express";
import {
  allDatesInRange,
  buildChannelMap,
  groupIntoDays,
  isValidIsoDate,
  toTimelineObservationResponse,
} from "../timeline/mapping";

// Package 7: the read/query layer over Observations already written by
// Package 5's extraction pipeline and corrected via the existing
// PATCH /api/observations/:id/correct (INB-07) — no new write logic here.
// Joins observations -> inboxEvents in memory via the existing
// req.data.observations.list()/req.data.inboxEvents.list() (both already
// scoped, ACC-02) rather than adding a new scopedDataAccess method — same
// "reuse what exists" pattern Package 4/5/6 used for pagination/filtering.
export const timelineRouter = Router();

const DEFAULT_RANGE_DAYS = 30;
const MAX_RANGE_DAYS = 366;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

type RangeResult = { ok: true; from: string; to: string } | { ok: false; errors: string[] };

function resolveRange(query: Record<string, unknown>): RangeResult {
  const errors: string[] = [];
  const rawFrom = typeof query.from === "string" ? query.from : undefined;
  const rawTo = typeof query.to === "string" ? query.to : undefined;

  if (rawFrom !== undefined && !isValidIsoDate(rawFrom)) errors.push("from must be an ISO date (YYYY-MM-DD)");
  if (rawTo !== undefined && !isValidIsoDate(rawTo)) errors.push("to must be an ISO date (YYYY-MM-DD)");
  if (errors.length > 0) return { ok: false, errors };

  // Default: last 30 days, inclusive of today.
  const to = rawTo ?? todayIso();
  const from = rawFrom ?? addDays(to, -(DEFAULT_RANGE_DAYS - 1));

  if (from > to) return { ok: false, errors: ["from must not be after to"] };
  if (allDatesInRange(from, to).length > MAX_RANGE_DAYS) {
    return { ok: false, errors: [`range must not exceed ${MAX_RANGE_DAYS} days`] };
  }

  return { ok: true, from, to };
}

function isTruthyFlag(value: unknown): boolean {
  return typeof value === "string" && value.toLowerCase() === "true";
}

timelineRouter.get("/api/timeline", async (req, res) => {
  if (!req.data) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  const range = resolveRange(req.query as Record<string, unknown>);
  if (!range.ok) {
    res.status(400).json({ error: "validation_failed", errors: range.errors });
    return;
  }
  const includeSuperseded = isTruthyFlag(req.query.includeSuperseded);

  const [allObservations, allInboxEvents] = await Promise.all([
    req.data.observations.list(),
    req.data.inboxEvents.list(),
  ]);

  const inRange = allObservations.filter(
    (o) => o.observedDate >= range.from && o.observedDate <= range.to && (includeSuperseded || !o.isSuperseded)
  );
  const channelMap = buildChannelMap(allInboxEvents);

  res.json({
    from: range.from,
    to: range.to,
    days: groupIntoDays(inRange, channelMap, range.from, range.to),
  });
});

timelineRouter.get("/api/timeline/:date", async (req, res) => {
  if (!req.data) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  const { date } = req.params;
  if (!isValidIsoDate(date)) {
    res.status(400).json({ error: "validation_failed", errors: ["date must be an ISO date (YYYY-MM-DD)"] });
    return;
  }
  const includeSuperseded = isTruthyFlag(req.query.includeSuperseded);

  const [allObservations, allInboxEvents] = await Promise.all([
    req.data.observations.list(),
    req.data.inboxEvents.list(),
  ]);

  const dayObservations = allObservations.filter(
    (o) => o.observedDate === date && (includeSuperseded || !o.isSuperseded)
  );
  const channelMap = buildChannelMap(allInboxEvents);
  const mapped = dayObservations
    .map((o) => toTimelineObservationResponse(o, channelMap))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  res.json({
    date,
    hasExplicitNonEvent: mapped.some((o) => o.isExplicitNonEvent),
    observations: mapped,
  });
});
