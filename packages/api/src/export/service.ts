import type { InferSelectModel } from "drizzle-orm";
import type { ScopedDataAccess } from "../data/scopedDataAccess";
import type { AppUser } from "../types";
import type { sourceArtifacts as sourceArtifactsTable, transcripts as transcriptsTable } from "../db";
import { toObservationResponse, type ObservationResponse } from "../observations/mapping";
import { toInboxEventResponse, type InboxEventResponse } from "../inbox/mapping";
import { fromDbRow as fromParticipantProfileRow, type ParticipantProfileResponse } from "../participantProfile/mapping";
import { toProgramWeekResponse, type ProgramWeekResponse } from "../weeklyReview/programWeekMapping";
import { toWeeklyReviewResponse, type WeeklyReviewResponse } from "../weeklyReview/mapping";
import { toExperimentResponse, type ExperimentResponse } from "../experiment/mapping";

// Package 11 Part C: a complete export of the user's own data.
//
// Cross-checked against every table in packages/db/src/schema/index.ts as
// of this package. Include/exclude decision for each:
//
//   users                            -> included, as `account`
//   sessions                         -> EXCLUDED: connect-pg-simple's own
//                                        session-store infrastructure, not
//                                        user-facing data.
//   participantProfiles              -> included, ALL versions
//   inboxEvents                      -> included
//   sourceArtifacts                  -> included (metadata only — no raw
//                                        audio bytes; storageRef is an
//                                        internal pointer, not content)
//   transcripts                      -> included, full text — this is the
//                                        user's own transcribed speech,
//                                        unlike SafetyEvents/the Privacy
//                                        Summary route, export exists to be
//                                        complete, not minimized
//   observations                     -> included, ALL rows including
//                                        superseded ones (explicitly
//                                        marked via isSuperseded)
//   programWeeks                     -> included
//   weeklyReviews                    -> included; each entry carries its
//                                        own inputObservationIds
//   weeklyReviewInputObservations    -> represented via the above
//                                        (weeklyReviews[].inputObservationIds),
//                                        not exported as a separate flat
//                                        junction array
//   experiments                      -> included; each entry carries its
//                                        own completionObservationIds
//   experimentCompletionObservations -> represented via the above
//                                        (experiments[].completionObservationIds)
//   safetyEvents                     -> included in full — this table has
//                                        no content field to begin with
//                                        (see safetyEvents.ts), so "not
//                                        flagged content itself" is
//                                        satisfied by construction
//   auditEvents                      -> EXCLUDED: a system security/audit
//                                        record of who-did-what, not
//                                        user-facing personal data — most
//                                        real systems exempt this class of
//                                        record from a personal-data export
//                                        for the same reason. Also uses
//                                        ON DELETE SET NULL, so an event
//                                        may not even stay attributable to
//                                        a specific user over time.

type SourceArtifactRow = InferSelectModel<typeof sourceArtifactsTable>;
type TranscriptRow = InferSelectModel<typeof transcriptsTable>;

export interface SourceArtifactExport {
  id: string;
  inboxEventId: string;
  artifactType: string;
  mimeType: string | null;
  durationSeconds: number | null;
  fileSizeBytes: number | null;
  storageRef: string;
  retentionState: string;
  createdAt: Date;
}

function toSourceArtifactExport(row: SourceArtifactRow): SourceArtifactExport {
  return {
    id: row.id,
    inboxEventId: row.inboxEventId,
    artifactType: row.artifactType,
    mimeType: row.mimeType,
    durationSeconds: row.durationSeconds !== null ? Number(row.durationSeconds) : null,
    fileSizeBytes: row.fileSizeBytes,
    storageRef: row.storageRef,
    retentionState: row.retentionState,
    createdAt: row.createdAt,
  };
}

export interface TranscriptExport {
  id: string;
  sourceArtifactId: string;
  modelName: string;
  modelVersion: string | null;
  confidence: number | null;
  text: string;
  createdAt: Date;
}

function toTranscriptExport(row: TranscriptRow): TranscriptExport {
  return {
    id: row.id,
    sourceArtifactId: row.sourceArtifactId,
    modelName: row.modelName,
    modelVersion: row.modelVersion,
    confidence: row.confidence,
    text: row.text,
    createdAt: row.createdAt,
  };
}

export interface WeeklyReviewExport extends WeeklyReviewResponse {
  inputObservationIds: string[];
}

export interface ExperimentExport extends ExperimentResponse {
  completionObservationIds: string[];
}

export interface AccountExport {
  id: string;
  email: string;
  authProvider: string;
  locale: string;
  timezone: string;
  consentVersion: string | null;
  consentAcceptedAt: Date | null;
  createdAt: Date;
}

export interface FullExport {
  exportedAt: string;
  account: AccountExport;
  participantProfiles: ParticipantProfileResponse[];
  observations: ObservationResponse[];
  inboxEvents: InboxEventResponse[];
  sourceArtifacts: SourceArtifactExport[];
  transcripts: TranscriptExport[];
  programWeeks: ProgramWeekResponse[];
  weeklyReviews: WeeklyReviewExport[];
  experiments: ExperimentExport[];
  safetyEvents: {
    id: string;
    policyCategory: string;
    pathwayKey: string;
    systemVersion: string;
    detectedAt: Date;
    resolvedAt: Date | null;
    resolutionStatus: string;
  }[];
}

export async function buildFullExport(data: ScopedDataAccess, appUser: AppUser): Promise<FullExport> {
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

  const weeklyReviewsExport: WeeklyReviewExport[] = await Promise.all(
    weeklyReviews.map(async (review) => ({
      ...toWeeklyReviewResponse(review),
      inputObservationIds: await data.weeklyReviewInputObservations.listObservationIds(review.id),
    }))
  );

  const experimentsExport: ExperimentExport[] = await Promise.all(
    experiments.map(async (experiment) => ({
      ...toExperimentResponse(experiment),
      completionObservationIds: await data.experimentCompletionObservations.listObservationIds(experiment.id),
    }))
  );

  return {
    exportedAt: new Date().toISOString(),
    account: {
      id: appUser.id,
      email: appUser.email,
      authProvider: appUser.authProvider,
      locale: appUser.locale,
      timezone: appUser.timezone,
      consentVersion: appUser.consentVersion,
      consentAcceptedAt: appUser.consentAcceptedAt,
      createdAt: appUser.createdAt,
    },
    participantProfiles: profileVersions.map(fromParticipantProfileRow),
    observations: observations.map(toObservationResponse),
    inboxEvents: inboxEvents.map(toInboxEventResponse),
    sourceArtifacts: sourceArtifacts.map(toSourceArtifactExport),
    transcripts: transcripts.map(toTranscriptExport),
    programWeeks: programWeeks.map(toProgramWeekResponse),
    weeklyReviews: weeklyReviewsExport,
    experiments: experimentsExport,
    safetyEvents: safetyEventRows.map((row) => ({
      id: row.id,
      policyCategory: row.policyCategory,
      pathwayKey: row.pathwayKey,
      systemVersion: row.systemVersion,
      detectedAt: row.detectedAt,
      resolvedAt: row.resolvedAt,
      resolutionStatus: row.resolutionStatus,
    })),
  };
}
