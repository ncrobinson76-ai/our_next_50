CREATE TYPE "public"."confidence_level" AS ENUM('measured', 'user_reported', 'approximate');--> statement-breakpoint
CREATE TYPE "public"."experiment_difficulty" AS ENUM('easy', 'moderate', 'hard');--> statement-breakpoint
CREATE TYPE "public"."experiment_status" AS ENUM('proposed', 'accepted', 'modified', 'declined', 'paused', 'retired');--> statement-breakpoint
CREATE TYPE "public"."inbox_channel" AS ENUM('voice', 'text', 'form');--> statement-breakpoint
CREATE TYPE "public"."inbox_status" AS ENUM('received', 'processing', 'processed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."length_unit" AS ENUM('in', 'cm');--> statement-breakpoint
CREATE TYPE "public"."observation_type" AS ENUM('weight', 'waist', 'sleep', 'meal', 'hunger', 'energy', 'activity', 'experiment_completion', 'context_reflection', 'symptom_safety', 'non_scale_win');--> statement-breakpoint
CREATE TYPE "public"."program_week_status" AS ENUM('scheduled', 'in_progress', 'completed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."retention_state" AS ENUM('active', 'pending_deletion', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."safety_policy_category" AS ENUM('urgent_symptom', 'crisis_language', 'disordered_eating', 'rapid_weight_change', 'other');--> statement-breakpoint
CREATE TYPE "public"."safety_resolution_status" AS ENUM('open', 'acknowledged', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."time_of_day" AS ENUM('morning', 'afternoon', 'evening', 'unspecified');--> statement-breakpoint
CREATE TYPE "public"."verification_state" AS ENUM('proposed', 'confirmed', 'corrected');--> statement-breakpoint
CREATE TYPE "public"."weekly_review_status" AS ENUM('draft', 'generated', 'delivered', 'acknowledged');--> statement-breakpoint
CREATE TYPE "public"."weight_unit" AS ENUM('lb', 'kg');--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"auth_provider" text NOT NULL,
	"auth_provider_id" text NOT NULL,
	"locale" text DEFAULT 'en-US' NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"consent_version" text NOT NULL,
	"consent_accepted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "participant_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"date_of_birth" date,
	"age_range" text,
	"height_value" numeric(6, 2),
	"height_unit" "length_unit",
	"starting_weight_value" numeric(6, 2) NOT NULL,
	"starting_weight_unit" "weight_unit" NOT NULL,
	"starting_weight_date" date NOT NULL,
	"waist_value" numeric(6, 2),
	"waist_unit" "length_unit",
	"goals" jsonb NOT NULL,
	"personal_reason" text,
	"typical_eating_pattern" text,
	"typical_sleep_pattern" text,
	"typical_activity_pattern" text,
	"exercise_preferences" text[],
	"physical_limitations" text[],
	"health_context" text,
	"on_weight_management_medication" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" "inbox_channel" NOT NULL,
	"status" "inbox_status" DEFAULT 'received' NOT NULL,
	"processing_state" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"raw_payload_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"inbox_event_id" uuid NOT NULL,
	"artifact_type" text NOT NULL,
	"mime_type" text,
	"duration_seconds" numeric(8, 2),
	"file_size_bytes" bigint,
	"storage_ref" text NOT NULL,
	"retention_state" "retention_state" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_artifact_id" uuid NOT NULL,
	"model_name" text NOT NULL,
	"model_version" text,
	"confidence" real,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "observation_type" NOT NULL,
	"observed_date" date NOT NULL,
	"time_of_day" time_of_day,
	"value" numeric(10, 3),
	"unit" text,
	"text_value" text,
	"structured_details" jsonb,
	"confidence_level" "confidence_level" DEFAULT 'user_reported' NOT NULL,
	"verification_state" "verification_state" DEFAULT 'proposed' NOT NULL,
	"source_inbox_event_id" uuid,
	"source_transcript_id" uuid,
	"is_superseded" boolean DEFAULT false NOT NULL,
	"supersedes_observation_id" uuid,
	"correction_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "program_weeks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"week_start_date" date NOT NULL,
	"week_end_date" date NOT NULL,
	"completed_week_number" integer,
	"evidence_sufficient" boolean DEFAULT false NOT NULL,
	"reflection_observation_id" uuid,
	"status" "program_week_status" DEFAULT 'scheduled' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weekly_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"program_week_id" uuid NOT NULL,
	"participant_profile_version_id" uuid NOT NULL,
	"ai_model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"structured_claims" jsonb NOT NULL,
	"rendered_report" text NOT NULL,
	"status" "weekly_review_status" DEFAULT 'draft' NOT NULL,
	"user_feedback" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weekly_review_input_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"weekly_review_id" uuid NOT NULL,
	"observation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experiments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"weekly_review_id" uuid,
	"recommendation" text NOT NULL,
	"rationale" text NOT NULL,
	"unchanged_behaviors" text[] DEFAULT '{}' NOT NULL,
	"target" text,
	"difficulty" "experiment_difficulty",
	"status" "experiment_status" DEFAULT 'proposed' NOT NULL,
	"started_at" timestamp with time zone,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experiment_completion_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"experiment_id" uuid NOT NULL,
	"observation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "safety_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"policy_category" "safety_policy_category" NOT NULL,
	"triage_confidence" real,
	"pathway_key" text NOT NULL,
	"system_version" text NOT NULL,
	"source_observation_id" uuid,
	"source_inbox_event_id" uuid,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution_status" "safety_resolution_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_user_id" uuid,
	"actor_user_id" uuid,
	"actor_type" text DEFAULT 'user' NOT NULL,
	"action_type" text NOT NULL,
	"target_entity_type" text NOT NULL,
	"target_entity_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "participant_profiles" ADD CONSTRAINT "participant_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_events" ADD CONSTRAINT "inbox_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_artifacts" ADD CONSTRAINT "source_artifacts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_artifacts" ADD CONSTRAINT "source_artifacts_inbox_event_id_inbox_events_id_fk" FOREIGN KEY ("inbox_event_id") REFERENCES "public"."inbox_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_source_artifact_id_source_artifacts_id_fk" FOREIGN KEY ("source_artifact_id") REFERENCES "public"."source_artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_source_inbox_event_id_inbox_events_id_fk" FOREIGN KEY ("source_inbox_event_id") REFERENCES "public"."inbox_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_source_transcript_id_transcripts_id_fk" FOREIGN KEY ("source_transcript_id") REFERENCES "public"."transcripts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_supersedes_observation_id_observations_id_fk" FOREIGN KEY ("supersedes_observation_id") REFERENCES "public"."observations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_weeks" ADD CONSTRAINT "program_weeks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_weeks" ADD CONSTRAINT "program_weeks_reflection_observation_id_observations_id_fk" FOREIGN KEY ("reflection_observation_id") REFERENCES "public"."observations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_reviews" ADD CONSTRAINT "weekly_reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_reviews" ADD CONSTRAINT "weekly_reviews_program_week_id_program_weeks_id_fk" FOREIGN KEY ("program_week_id") REFERENCES "public"."program_weeks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_reviews" ADD CONSTRAINT "weekly_reviews_participant_profile_version_id_participant_profiles_id_fk" FOREIGN KEY ("participant_profile_version_id") REFERENCES "public"."participant_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_review_input_observations" ADD CONSTRAINT "weekly_review_input_observations_weekly_review_id_weekly_reviews_id_fk" FOREIGN KEY ("weekly_review_id") REFERENCES "public"."weekly_reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_review_input_observations" ADD CONSTRAINT "weekly_review_input_observations_observation_id_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."observations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_weekly_review_id_weekly_reviews_id_fk" FOREIGN KEY ("weekly_review_id") REFERENCES "public"."weekly_reviews"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_completion_observations" ADD CONSTRAINT "experiment_completion_observations_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_completion_observations" ADD CONSTRAINT "experiment_completion_observations_observation_id_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."observations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safety_events" ADD CONSTRAINT "safety_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safety_events" ADD CONSTRAINT "safety_events_source_observation_id_observations_id_fk" FOREIGN KEY ("source_observation_id") REFERENCES "public"."observations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safety_events" ADD CONSTRAINT "safety_events_source_inbox_event_id_inbox_events_id_fk" FOREIGN KEY ("source_inbox_event_id") REFERENCES "public"."inbox_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_auth_provider_idx" ON "users" USING btree ("auth_provider","auth_provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "participant_profiles_user_version_idx" ON "participant_profiles" USING btree ("user_id","version");--> statement-breakpoint
CREATE INDEX "participant_profiles_user_id_idx" ON "participant_profiles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "inbox_events_user_id_idx" ON "inbox_events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "inbox_events_status_idx" ON "inbox_events" USING btree ("status");--> statement-breakpoint
CREATE INDEX "source_artifacts_user_id_idx" ON "source_artifacts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "source_artifacts_inbox_event_id_idx" ON "source_artifacts" USING btree ("inbox_event_id");--> statement-breakpoint
CREATE INDEX "transcripts_user_id_idx" ON "transcripts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "transcripts_source_artifact_id_idx" ON "transcripts" USING btree ("source_artifact_id");--> statement-breakpoint
CREATE INDEX "observations_user_id_idx" ON "observations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "observations_user_date_idx" ON "observations" USING btree ("user_id","observed_date");--> statement-breakpoint
CREATE INDEX "observations_user_type_idx" ON "observations" USING btree ("user_id","type");--> statement-breakpoint
CREATE INDEX "observations_is_superseded_idx" ON "observations" USING btree ("is_superseded");--> statement-breakpoint
CREATE UNIQUE INDEX "program_weeks_user_week_start_idx" ON "program_weeks" USING btree ("user_id","week_start_date");--> statement-breakpoint
CREATE INDEX "program_weeks_user_id_idx" ON "program_weeks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "weekly_reviews_user_id_idx" ON "weekly_reviews" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "weekly_reviews_program_week_id_idx" ON "weekly_reviews" USING btree ("program_week_id");--> statement-breakpoint
CREATE INDEX "weekly_reviews_profile_version_id_idx" ON "weekly_reviews" USING btree ("participant_profile_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_review_input_observations_pair_idx" ON "weekly_review_input_observations" USING btree ("weekly_review_id","observation_id");--> statement-breakpoint
CREATE INDEX "experiments_user_id_idx" ON "experiments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "experiments_status_idx" ON "experiments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "experiments_weekly_review_id_idx" ON "experiments" USING btree ("weekly_review_id");--> statement-breakpoint
CREATE UNIQUE INDEX "experiment_completion_observations_pair_idx" ON "experiment_completion_observations" USING btree ("experiment_id","observation_id");--> statement-breakpoint
CREATE INDEX "safety_events_user_id_idx" ON "safety_events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "safety_events_policy_category_idx" ON "safety_events" USING btree ("policy_category");--> statement-breakpoint
CREATE INDEX "safety_events_resolution_status_idx" ON "safety_events" USING btree ("resolution_status");--> statement-breakpoint
CREATE INDEX "audit_events_subject_user_id_idx" ON "audit_events" USING btree ("subject_user_id");--> statement-breakpoint
CREATE INDEX "audit_events_actor_user_id_idx" ON "audit_events" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "audit_events_target_idx" ON "audit_events" USING btree ("target_entity_type","target_entity_id");