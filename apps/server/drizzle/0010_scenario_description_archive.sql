ALTER TABLE "orchestrations" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "orchestrations" ADD COLUMN "archived_at" timestamp with time zone;