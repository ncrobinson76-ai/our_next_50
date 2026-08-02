import type { InferSelectModel } from "drizzle-orm";
import type { inboxEvents, observations } from "../db";

type ObservationRow = InferSelectModel<typeof observations>;
type InboxEventRow = InferSelectModel<typeof inboxEvents>;

// PRD Section 8.4: an observation, an explicit non-event, and "no entry"
// must all be genuinely distinguishable from the response shape alone —
// not something a client has to infer correctly. This is the response
// shape that carries that distinction: `channel`/`isCorrection` add the
// provenance this package was asked for on top of the existing
// Observation fields already exposed by observations/mapping.ts.
export interface TimelineObservationResponse {
  id: string;
  type: string;
  observedDate: string;
  timeOfDay: string | null;
  value: number | null;
  unit: string | null;
  textValue: string | null;
  structuredDetails: unknown;
  isExplicitNonEvent: boolean;
  confidenceLevel: string;
  verificationState: string;
  // Which channel produced this observation (text/form/voice), via
  // sourceInboxEventId -> InboxEvent.channel. Null when there's no source
  // InboxEvent — notably, a correction inserted via PATCH
  // /api/observations/:id/correct always has sourceInboxEventId = null
  // (see routes/observations.ts), so a null channel here reliably means
  // "this row exists because of a direct user correction, not from
  // processing a submission."
  channel: string | null;
  // supersedesObservationId !== null, surfaced as its own boolean so a
  // client doesn't have to infer "this is a correction" from a raw id
  // field.
  isCorrection: boolean;
  supersedesObservationId: string | null;
  isSuperseded: boolean;
  correctionReason: string | null;
  createdAt: Date;
}

export function toTimelineObservationResponse(
  row: ObservationRow,
  channelByInboxEventId: Map<string, string>
): TimelineObservationResponse {
  return {
    id: row.id,
    type: row.type,
    observedDate: row.observedDate,
    timeOfDay: row.timeOfDay,
    value: row.value !== null ? Number(row.value) : null,
    unit: row.unit,
    textValue: row.textValue,
    structuredDetails: row.structuredDetails,
    isExplicitNonEvent: row.isExplicitNonEvent,
    confidenceLevel: row.confidenceLevel,
    verificationState: row.verificationState,
    channel: row.sourceInboxEventId ? (channelByInboxEventId.get(row.sourceInboxEventId) ?? null) : null,
    isCorrection: row.supersedesObservationId !== null,
    supersedesObservationId: row.supersedesObservationId,
    isSuperseded: row.isSuperseded,
    correctionReason: row.correctionReason,
    createdAt: row.createdAt,
  };
}

export function buildChannelMap(inboxEventRows: InboxEventRow[]): Map<string, string> {
  return new Map(inboxEventRows.map((row) => [row.id, row.channel]));
}

// A date-group in the timeline response. Absence of any date-group in the
// requested range would be ambiguous ("did the server just not return it,
// or is there really nothing there?") — see README.md's "no entry"
// convention — so every date in [from, to] always gets an entry, even
// when `observations` is empty.
export interface TimelineDay {
  date: string;
  // Explicit, per-date marker — PRD Section 8.4 asks that this not be
  // something a client has to notice buried in a single row's field.
  // True iff at least one observation in this day's (filtered)
  // `observations` array has isExplicitNonEvent = true.
  hasExplicitNonEvent: boolean;
  observations: TimelineObservationResponse[];
}

export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime());
}

/** Every YYYY-MM-DD from `from` to `to`, inclusive, ascending. */
export function allDatesInRange(from: string, to: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor.getTime() <= end.getTime()) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

export function groupIntoDays(
  observationRows: ObservationRow[],
  channelByInboxEventId: Map<string, string>,
  from: string,
  to: string
): TimelineDay[] {
  const byDate = new Map<string, TimelineObservationResponse[]>();
  for (const row of observationRows) {
    const mapped = toTimelineObservationResponse(row, channelByInboxEventId);
    const existing = byDate.get(row.observedDate);
    if (existing) existing.push(mapped);
    else byDate.set(row.observedDate, [mapped]);
  }
  for (const list of byDate.values()) {
    list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  return allDatesInRange(from, to).map((date) => {
    const dayObservations = byDate.get(date) ?? [];
    return {
      date,
      hasExplicitNonEvent: dayObservations.some((o) => o.isExplicitNonEvent),
      observations: dayObservations,
    };
  });
}
