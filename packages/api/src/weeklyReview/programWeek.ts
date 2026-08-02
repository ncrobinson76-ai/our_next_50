import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import type { observations, participantProfiles, programWeeks } from "../db";
import type { ScopedDataAccess } from "../data/scopedDataAccess";

export type ProgramWeekRow = InferSelectModel<typeof programWeeks>;
type ProgramWeekInsert = Omit<InferInsertModel<typeof programWeeks>, "userId">;
type ProfileRow = InferSelectModel<typeof participantProfiles>;
type ObservationRow = InferSelectModel<typeof observations>;

const WEEK_LENGTH_DAYS = 7;

// PRD Section 8.7's "too few logged days" threshold, made explicit rather
// than left implicit in the synthesis model's own judgment. Derived from
// packages/eval-harness's own fixtures, not picked arbitrarily:
// insufficient-evidence.json logs 1 of 7 days, missed-two-weeks.json logs
// 2 of 14, and both were built to trigger the prompt's insufficient-
// evidence path; missed-day.json logs 6 of 7 and was built to get normal
// synthesis. 3 sits cleanly between the two, with margin on both sides.
export const EVIDENCE_SUFFICIENCY_MIN_LOGGED_DAYS = 3;

export function isEvidenceSufficient(loggedDayCount: number): boolean {
  return loggedDayCount >= EVIDENCE_SUFFICIENCY_MIN_LOGGED_DAYS;
}

/** Distinct calendar dates with at least one non-superseded Observation in [weekStartDate, weekEndDate]. */
export function computeLoggedDayCount(
  allObservations: ObservationRow[],
  weekStartDate: string,
  weekEndDate: string
): number {
  const days = new Set<string>();
  for (const obs of allObservations) {
    if (obs.isSuperseded) continue;
    if (obs.observedDate >= weekStartDate && obs.observedDate <= weekEndDate) {
      days.add(obs.observedDate);
    }
  }
  return days.size;
}

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return toISODate(d);
}

function daysBetween(startIso: string, endIso: string): number {
  const startMs = new Date(`${startIso}T00:00:00.000Z`).getTime();
  const endMs = new Date(`${endIso}T00:00:00.000Z`).getTime();
  return Math.floor((endMs - startMs) / (1000 * 60 * 60 * 24));
}

function weekWindowForIndex(programStartDate: string, index: number): { weekStartDate: string; weekEndDate: string } {
  const weekStartDate = addDays(programStartDate, index * WEEK_LENGTH_DAYS);
  const weekEndDate = addDays(weekStartDate, WEEK_LENGTH_DAYS - 1);
  return { weekStartDate, weekEndDate };
}

/** Which sequential 7-day window (0-indexed from programStartDate) a given date falls in. */
function weekIndexForDate(programStartDate: string, date: string): number {
  return Math.max(0, Math.floor(daysBetween(programStartDate, date) / WEEK_LENGTH_DAYS));
}

/**
 * The user's program start date is anchored to their version-1
 * ParticipantProfile's startingWeightDate — the one date onboarding
 * explicitly captured for this purpose. Deliberately NOT the latest
 * profile version's startingWeightDate: a later correction to that field
 * (via PATCH .../current) must not retroactively shift which 7-day windows
 * every past ProgramWeek belongs to.
 */
export function findProgramStartDate(profileVersions: ProfileRow[]): string | null {
  const versionOne = profileVersions.find((p) => p.version === 1);
  return versionOne?.startingWeightDate ?? null;
}

export interface ProgramWeekSyncResult {
  current: ProgramWeekRow;
  /** Every ProgramWeek created or corrected to "skipped" as part of this sync — the honest missed-time record. */
  backfilled: ProgramWeekRow[];
}

/**
 * PRD Section 8.7: real, sequential 7-day windows from the user's actual
 * program start date — not just "the last 7 days from today" (Package 9's
 * placeholder). Walks every window from index 0 through today's window,
 * creating any that don't exist yet. A window strictly before today's is
 * never left silently unaccounted for: if it has no row at all, one is
 * created with status "skipped"; if a row already exists but was never
 * carried to "completed" (a review was never generated for it), it's
 * corrected to "skipped" too — either way, a past week without a
 * completed review honestly reads as skipped, not silently absent.
 */
export async function syncProgramWeeksThroughToday(
  data: ScopedDataAccess,
  programStartDate: string
): Promise<ProgramWeekSyncResult> {
  const today = toISODate(new Date());
  const currentIndex = weekIndexForDate(programStartDate, today);

  const existingWeeks = await data.programWeeks.list();
  const existingByStart = new Map(existingWeeks.map((w) => [w.weekStartDate, w]));
  const allObservations = await data.observations.list();

  const backfilled: ProgramWeekRow[] = [];
  let current: ProgramWeekRow | undefined;

  for (let index = 0; index <= currentIndex; index++) {
    const { weekStartDate, weekEndDate } = weekWindowForIndex(programStartDate, index);
    const isCurrentWindow = index === currentIndex;
    const existing = existingByStart.get(weekStartDate);

    if (!existing) {
      const loggedDayCount = computeLoggedDayCount(allObservations, weekStartDate, weekEndDate);
      // Locally-typed const rather than an inline literal — see
      // weeklyReview/service.ts's WeeklyReviewInsert comment for why.
      const insertValues: ProgramWeekInsert = {
        weekStartDate,
        weekEndDate,
        status: isCurrentWindow ? "scheduled" : "skipped",
        evidenceSufficient: isEvidenceSufficient(loggedDayCount),
      };
      const created = await data.programWeeks.create(insertValues);
      if (isCurrentWindow) current = created;
      else backfilled.push(created);
      continue;
    }

    if (!isCurrentWindow && existing.status === "scheduled") {
      // A row exists for a past week but it never got a review generated
      // — the week fully elapsed without completion, so it reads the same
      // as a fully-missed week from an engagement standpoint.
      const corrected = await data.programWeeks.update(existing.id, { status: "skipped" });
      backfilled.push(corrected!);
      continue;
    }

    if (isCurrentWindow) current = existing;
  }

  return { current: current!, backfilled };
}
