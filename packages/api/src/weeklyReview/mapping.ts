import type { InferSelectModel } from "drizzle-orm";
import type { weeklyReviews } from "../db";
import type { StructuredClaims, WeeklyReviewUserFeedback } from "../db";

type WeeklyReviewRow = InferSelectModel<typeof weeklyReviews>;

export interface WeeklyReviewResponse {
  id: string;
  programWeekId: string;
  participantProfileVersionId: string;
  aiModel: string;
  promptVersion: string;
  structuredClaims: StructuredClaims;
  renderedReport: string;
  status: string;
  userFeedback: WeeklyReviewUserFeedback | null;
  createdAt: Date;
}

export function toWeeklyReviewResponse(row: WeeklyReviewRow): WeeklyReviewResponse {
  return {
    id: row.id,
    programWeekId: row.programWeekId,
    participantProfileVersionId: row.participantProfileVersionId,
    aiModel: row.aiModel,
    promptVersion: row.promptVersion,
    structuredClaims: row.structuredClaims,
    renderedReport: row.renderedReport,
    status: row.status,
    userFeedback: row.userFeedback ?? null,
    createdAt: row.createdAt,
  };
}
