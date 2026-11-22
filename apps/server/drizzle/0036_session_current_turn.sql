ALTER TABLE "sessions" ADD COLUMN "current_turn" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_current_turn" CHECK ("sessions"."current_turn" >= 0);--> statement-breakpoint
UPDATE "sessions" SET "current_turn" = (SELECT count(*) FROM "session_events" WHERE "session_events"."session_id" = "sessions"."id" AND "session_events"."type" = 'turn_started');
