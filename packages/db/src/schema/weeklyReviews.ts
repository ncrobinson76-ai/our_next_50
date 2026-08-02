import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { weeklyReviewStatusEnum } from "./enums";
import { participantProfiles } from "./participantProfiles";
import { programWeeks } from "./programWeeks";
import { users } from "./users";

// Structured claims produced by the synthesis engine. Mirrors SynthesisOutput
// in packages/eval-harness/types.ts (recordedFacts, observationsSummary,
// tentativeHypotheses, whatsWorking, friction, whatShouldRemainUnchanged,
// proposedNextStep) — keep these two in sync if that shape changes.
export interface StructuredClaims {
  recordedFacts: string[];
  observationsSummary: string[];
  tentativeHypotheses: string[];
  whatsWorking: string[];
  friction: string[];
  whatShouldRemainUnchanged: string[];
  proposedNextStep: {
    type: "experiment" | "no-change" | "insufficient-evidence";
    description: string;
  };
}

export interface WeeklyReviewUserFeedback {
  helpful?: boolean;
  rating?: number;
  comment?: string;
}

// WeeklyReview: the AI-generated synthesis for one ProgramWeek. Which
// Observations fed into it is captured by the weeklyReviewInputObservations
// junction table (see weeklyReviewInputObservations.ts); which ProgramWeek
// and which ParticipantProfile version are captured directly below.
export const weeklyReviews = pgTable(
  "weekly_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    programWeekId: uuid("program_week_id")
      .notNull()
      .references(() => programWeeks.id, { onDelete: "cascade" }),

    // Which specific ParticipantProfile version was active when this review
    // was generated — required per PRD so reviews can always be traced back
    // to the baseline data that was in effect at the time.
    participantProfileVersionId: uuid("participant_profile_version_id")
      .notNull()
      .references(() => participantProfiles.id, { onDelete: "cascade" }),

    aiModel: text("ai_model").notNull(),
    promptVersion: text("prompt_version").notNull(),

    structuredClaims: jsonb("structured_claims").$type<StructuredClaims>().notNull(),
    renderedReport: text("rendered_report").notNull(),

    status: weeklyReviewStatusEnum("status").notNull().default("draft"),
    userFeedback: jsonb("user_feedback").$type<WeeklyReviewUserFeedback>(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("weekly_reviews_user_id_idx").on(table.userId),
    index("weekly_reviews_program_week_id_idx").on(table.programWeekId),
    index("weekly_reviews_profile_version_id_idx").on(table.participantProfileVersionId),
  ]
);
