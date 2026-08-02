ALTER TYPE "public"."inbox_status" ADD VALUE 'safety_flagged';--> statement-breakpoint
ALTER TYPE "public"."inbox_status" ADD VALUE 'needs_followup';--> statement-breakpoint
ALTER TABLE "inbox_events" ADD COLUMN "pending_follow_up_question" text;