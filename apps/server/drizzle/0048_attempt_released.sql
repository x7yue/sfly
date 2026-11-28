ALTER TABLE "runs" ADD COLUMN "vault_deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "late_reports_dropped" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "abandoned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "released_at" timestamp with time zone;--> statement-breakpoint
-- 写入时打码之前的运行没有加密副本，它们的尝试离不离手无关紧要：记成已离手，不进上面的索引。
UPDATE "tasks" SET "released_at" = coalesce("tasks"."ended_at", "tasks"."queued_at") FROM "runs" WHERE "runs"."id" = "tasks"."run_id" AND NOT "runs"."masked_on_write" AND "tasks"."lease_expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "tasks_unreleased" ON "tasks" USING btree ("agent_name") WHERE "tasks"."lease_expires_at" is not null and "tasks"."released_at" is null;