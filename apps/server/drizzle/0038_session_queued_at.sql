ALTER TABLE "sessions" ADD COLUMN "queued_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "sessions_project_queue" ON "sessions" USING btree ("project_id","queued_at","id") WHERE "sessions"."status" = 'queued';--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_queued_at" CHECK (("sessions"."status" = 'queued') = ("sessions"."queued_at" is not null));