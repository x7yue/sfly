ALTER TABLE "orchestrations" ADD COLUMN "run_notify_bot" text;--> statement-breakpoint
ALTER TABLE "orchestrations" ADD COLUMN "run_notify_trigger" text DEFAULT 'failed' NOT NULL;--> statement-breakpoint
ALTER TABLE "orchestrations" ADD COLUMN "run_notify_title" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "orchestrations" ADD COLUMN "run_notify_note" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "notification_bot" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "notification_not_sent" text;