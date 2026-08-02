import type { InferSelectModel } from "drizzle-orm";
import type { ScopedDataAccess } from "../data/scopedDataAccess";
import type { AppUser } from "../types";
import type { safetyEvents as safetyEventsTable } from "../db";

type SafetyEventRow = InferSelectModel<typeof safetyEventsTable>;
type SafetyCategory = SafetyEventRow["policyCategory"];

// Mirrors safetyPolicyCategoryEnum in packages/db/src/schema/enums.ts —
// every value the DB column can hold, so a category with zero events still
// shows up as 0 rather than being silently absent.
const SAFETY_CATEGORIES: SafetyCategory[] = [
  "urgent_symptom",
  "crisis_language",
  "disordered_eating",
  "rapid_weight_change",
  "pregnancy_related",
  "extreme_restriction",
  "other",
];

export interface PrivacySummary {
  consent: {
    version: string | null;
    acceptedAt: Date | null;
  };
  counts: {
    participantProfileVersions: number;
    observations: number;
    inboxEvents: number;
    sourceArtifacts: {
      active: number;
      pendingDeletion: number;
      deleted: number;
    };
    transcripts: number;
    programWeeks: number;
    weeklyReviews: number;
    experiments: number;
    /**
     * Per PRD Section 11 / Package 2's ACC-05 safe-logging rule: category
     * counts only, never the flagged content itself (which this table
     * never stores in the first place — see safetyEvents.ts's own
     * comment).
     */
    safetyEventsByCategory: Record<SafetyCategory, number>;
  };
}

export async function buildPrivacySummary(data: ScopedDataAccess, appUser: AppUser): Promise<PrivacySummary> {
  const [
    profileVersions,
    observations,
    inboxEvents,
    sourceArtifacts,
    transcripts,
    programWeeks,
    weeklyReviews,
    experiments,
    safetyEventRows,
  ] = await Promise.all([
    data.participantProfiles.list(),
    data.observations.list(),
    data.inboxEvents.list(),
    data.sourceArtifacts.list(),
    data.transcripts.list(),
    data.programWeeks.list(),
    data.weeklyReviews.list(),
    data.experiments.list(),
    data.safetyEvents.list(),
  ]);

  const safetyEventsByCategory = Object.fromEntries(SAFETY_CATEGORIES.map((c) => [c, 0])) as Record<
    SafetyCategory,
    number
  >;
  for (const event of safetyEventRows) safetyEventsByCategory[event.policyCategory]++;

  return {
    consent: {
      version: appUser.consentVersion,
      acceptedAt: appUser.consentAcceptedAt,
    },
    counts: {
      participantProfileVersions: profileVersions.length,
      observations: observations.length,
      inboxEvents: inboxEvents.length,
      sourceArtifacts: {
        active: sourceArtifacts.filter((a) => a.retentionState === "active").length,
        pendingDeletion: sourceArtifacts.filter((a) => a.retentionState === "pending_deletion").length,
        deleted: sourceArtifacts.filter((a) => a.retentionState === "deleted").length,
      },
      transcripts: transcripts.length,
      programWeeks: programWeeks.length,
      weeklyReviews: weeklyReviews.length,
      experiments: experiments.length,
      safetyEventsByCategory,
    },
  };
}
