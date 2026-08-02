import type { InferSelectModel } from "drizzle-orm";
import type { experiments } from "../db";

type ExperimentRow = InferSelectModel<typeof experiments>;

export interface ExperimentResponse {
  id: string;
  weeklyReviewId: string | null;
  recommendation: string;
  rationale: string;
  unchangedBehaviors: string[];
  target: string | null;
  difficulty: string | null;
  status: string;
  startedAt: Date | null;
  outcome: string | null;
  createdAt: Date;
}

export function toExperimentResponse(row: ExperimentRow): ExperimentResponse {
  return {
    id: row.id,
    weeklyReviewId: row.weeklyReviewId,
    recommendation: row.recommendation,
    rationale: row.rationale,
    unchangedBehaviors: row.unchangedBehaviors,
    target: row.target,
    difficulty: row.difficulty,
    status: row.status,
    startedAt: row.startedAt,
    outcome: row.outcome,
    createdAt: row.createdAt,
  };
}
