ALTER TABLE "inbox_events" ALTER COLUMN "raw_payload_ref" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "inbox_events" ADD COLUMN "payload" jsonb;