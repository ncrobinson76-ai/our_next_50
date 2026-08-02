import { boolean, date, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { lengthUnitEnum, weightUnitEnum } from "./enums";
import { users } from "./users";

// A single goal entry. Mirrors the shape of BaselineProfile.goal in
// packages/eval-harness/types.ts, pluralized since a profile can carry more
// than one goal over time.
export interface ProfileGoal {
  type: "weight-loss" | "weight-gain" | "maintenance" | "body-composition" | "other";
  description: string;
  targetWeight?: { value: number; unit: "lb" | "kg" };
}

// ParticipantProfile: versioned baseline data. Each edit inserts a new row
// with an incremented version rather than updating in place — old versions
// are retained so a WeeklyReview can record exactly which profile version
// was active when it was generated (see weeklyReviews.participantProfileVersionId).
export const participantProfiles = pgTable(
  "participant_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    // Incrementing per-user version number. Combined with userId, uniquely
    // identifies this profile snapshot.
    version: integer("version").notNull(),

    // Age range or DOB — either may be collected depending on what the user
    // is comfortable sharing; at least one is expected but not DB-enforced.
    dateOfBirth: date("date_of_birth"),
    ageRange: text("age_range"),

    heightValue: numeric("height_value", { precision: 6, scale: 2 }),
    heightUnit: lengthUnitEnum("height_unit"),

    startingWeightValue: numeric("starting_weight_value", { precision: 6, scale: 2 }).notNull(),
    startingWeightUnit: weightUnitEnum("starting_weight_unit").notNull(),
    startingWeightDate: date("starting_weight_date").notNull(),

    waistValue: numeric("waist_value", { precision: 6, scale: 2 }),
    waistUnit: lengthUnitEnum("waist_unit"),

    goals: jsonb("goals").$type<ProfileGoal[]>().notNull(),
    personalReason: text("personal_reason"),

    typicalEatingPattern: text("typical_eating_pattern"),
    typicalSleepPattern: text("typical_sleep_pattern"),
    typicalActivityPattern: text("typical_activity_pattern"),
    exercisePreferences: text("exercise_preferences").array(),
    physicalLimitations: text("physical_limitations").array(),

    // Deliberately high-level/free-text per PRD guidance — not a detailed
    // medical history field.
    healthContext: text("health_context"),

    onWeightManagementMedication: boolean("on_weight_management_medication")
      .notNull()
      .default(false),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("participant_profiles_user_version_idx").on(table.userId, table.version),
    index("participant_profiles_user_id_idx").on(table.userId),
  ]
);
