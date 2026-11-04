ALTER TABLE "tasks" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "queue_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "tasks_lease" ON "tasks" USING btree ("lease_expires_at") WHERE "tasks"."status" = 'running';--> statement-breakpoint
CREATE INDEX "tasks_queue_timeout" ON "tasks" USING btree ("queue_expires_at") WHERE "tasks"."status" = 'queued';