import type { InferSelectModel } from "drizzle-orm";
import type { observations } from "../db";

type ObservationRow = InferSelectModel<typeof observations>;

export interface ObservationResponse {
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
  sourceInboxEventId: string | null;
  isSuperseded: boolean;
  supersedesObservationId: string | null;
  correctionReason: string | null;
  createdAt: Date;
}

export function toObservationResponse(row: ObservationRow): ObservationResponse {
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
    sourceInboxEventId: row.sourceInboxEventId,
    isSuperseded: row.isSuperseded,
    supersedesObservationId: row.supersedesObservationId,
    correctionReason: row.correctionReason,
    createdAt: row.createdAt,
  };
}
