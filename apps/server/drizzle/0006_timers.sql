ALTER TABLE "tasks" ADD COLUMN "wake_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "tasks_waiting" ON "tasks" USING btree ("wake_at") WHERE "tasks"."status" = 'waiting';