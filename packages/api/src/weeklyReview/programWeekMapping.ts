import type { InferSelectModel } from "drizzle-orm";
import type { programWeeks } from "../db";

type ProgramWeekRow = InferSelectModel<typeof programWeeks>;

export interface ProgramWeekResponse {
  id: string;
  weekStartDate: string;
  weekEndDate: string;
  completedWeekNumber: number | null;
  evidenceSufficient: boolean;
  status: string;
  createdAt: Date;
}

export function toProgramWeekResponse(row: ProgramWeekRow): ProgramWeekResponse {
  return {
    id: row.id,
    weekStartDate: row.weekStartDate,
    weekEndDate: row.weekEndDate,
    completedWeekNumber: row.completedWeekNumber,
    evidenceSufficient: row.evidenceSufficient,
    status: row.status,
    createdAt: row.createdAt,
  };
}
