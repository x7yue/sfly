ALTER TABLE "orchestration_versions" ADD COLUMN "author_via" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "triggered_via" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cancel_requested_via" text;