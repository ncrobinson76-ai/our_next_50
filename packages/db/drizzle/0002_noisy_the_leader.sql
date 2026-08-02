CREATE TABLE "sessions" (
	"sid" varchar PRIMARY KEY NOT NULL,
	"sess" json NOT NULL,
	"expire" timestamp (6) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "consent_version" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "consent_accepted_at" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "sessions_expire_idx" ON "sessions" USING btree ("expire");