ALTER TABLE "runs" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cancel_requested_by" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cancel_forced_at" timestamp with time zone;