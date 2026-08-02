import type { InferSelectModel } from "drizzle-orm";
import type { participantProfiles, programWeeks } from "../db";
import type { ScopedDataAccess } from "../data/scopedDataAccess";

export type ProgramWeekRow = InferSelectModel<typeof programWeeks>;
type ProfileRow = InferSelectModel<typeof participantProfiles>;

const WEEK_LENGTH_DAYS = 7;

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return toISODate(d);
}

/**
 * A simple 7-day calendar window from the user's program start date — full
 * missed-time recovery logic (e.g. what happens to skipped weeks) is
 * explicitly Package 10's job, not this one's.
 */
export function computeCurrentWeekWindow(
  programStartDate: string,
  today: string
): { weekStartDate: string; weekEndDate: string } {
  const startMs = new Date(`${programStartDate}T00:00:00.000Z`).getTime();
  const todayMs = new Date(`${today}T00:00:00.000Z`).getTime();
  const daysSinceStart = Math.max(0, Math.floor((todayMs - startMs) / (1000 * 60 * 60 * 24)));
  const weeksSinceStart = Math.floor(daysSinceStart / WEEK_LENGTH_DAYS);
  const weekStartDate = addDays(programStartDate, weeksSinceStart * WEEK_LENGTH_DAYS);
  const weekEndDate = addDays(weekStartDate, WEEK_LENGTH_DAYS - 1);
  return { weekStartDate, weekEndDate };
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

/**
 * Finds the ProgramWeek for the current calendar window, creating it if
 * this is the first time this window has been touched.
 */
export async function getOrCreateCurrentProgramWeek(
  data: ScopedDataAccess,
  programStartDate: string
): Promise<ProgramWeekRow> {
  const today = toISODate(new Date());
  const { weekStartDate, weekEndDate } = computeCurrentWeekWindow(programStartDate, today);

  const existingWeeks = await data.programWeeks.list();
  const found = existingWeeks.find((w) => w.weekStartDate === weekStartDate);
  if (found) return found;

  return data.programWeeks.create({ weekStartDate, weekEndDate });
}
