CREATE TABLE "session_events" (
	"session_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "session_events_session_id_seq_pk" PRIMARY KEY("session_id","seq"),
	CONSTRAINT "session_events_seq" CHECK ("session_events"."seq" >= 1)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"created_by" text NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"last_activity_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sessions_status" CHECK ("sessions"."status" in ('idle', 'running', 'queued', 'ended'))
);
--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_events_turn_end" ON "session_events" USING btree ("session_id","seq" DESC NULLS LAST) WHERE "session_events"."type" = 'turn_end';--> statement-breakpoint
CREATE INDEX "sessions_project_activity" ON "sessions" USING btree ("project_id","last_activity_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_one_running_per_project" ON "sessions" USING btree ("project_id") WHERE "sessions"."status" = 'running';--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;