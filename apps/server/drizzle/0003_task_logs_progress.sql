ALTER TABLE "tasks" ADD COLUMN "progress" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "log_path" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "log_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "log_seq" bigint DEFAULT 0 NOT NULL;