ALTER TABLE "api_tokens" DROP CONSTRAINT "api_tokens_session_id_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "orchestration_versions" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_id_project" UNIQUE("id","project_id");--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_session_project_fk" FOREIGN KEY ("session_id","project_id") REFERENCES "public"."sessions"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orchestration_versions" ADD CONSTRAINT "orchestration_versions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orchestration_versions_session" ON "orchestration_versions" USING btree ("session_id") WHERE "orchestration_versions"."session_id" is not null;--> statement-breakpoint
CREATE INDEX "runs_session" ON "runs" USING btree ("session_id") WHERE "runs"."session_id" is not null;
