ALTER TABLE "session_events" ADD COLUMN "assistant_epoch" text;--> statement-breakpoint
ALTER TABLE "session_events" ADD COLUMN "assistant_seq" bigint;--> statement-breakpoint
CREATE UNIQUE INDEX "session_events_assistant_source_idx" ON "session_events" USING btree ("assistant_epoch","assistant_seq") WHERE "session_events"."assistant_epoch" is not null;--> statement-breakpoint
CREATE INDEX "session_events_assistant_latest" ON "session_events" USING btree ("created_at" DESC NULLS LAST,"assistant_seq" DESC NULLS LAST) WHERE "session_events"."assistant_epoch" is not null;--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_assistant_source" CHECK (("session_events"."assistant_epoch" is null) = ("session_events"."assistant_seq" is null));