ALTER TABLE "api_tokens" DROP CONSTRAINT "api_tokens_session_id_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "orchestration_versions" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_id_project" UNIQUE("id","project_id");--> statement-breakpoint
-- 会话令牌的项目要和它所属会话的项目一致（组合外键）：加约束之前先删掉对不上的旧行，免得升级失败。会话令牌的签发还没有，
-- 库里现在不会有这样的行；写在这里是免得合入的先后顺序变了之后出事。令牌只是凭据，删掉不丢任何记录。
DELETE FROM "api_tokens" WHERE "session_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "sessions" WHERE "sessions"."id" = "api_tokens"."session_id" AND "sessions"."project_id" = "api_tokens"."project_id");--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_session_project_fk" FOREIGN KEY ("session_id","project_id") REFERENCES "public"."sessions"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orchestration_versions" ADD CONSTRAINT "orchestration_versions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orchestration_versions_session" ON "orchestration_versions" USING btree ("session_id") WHERE "orchestration_versions"."session_id" is not null;--> statement-breakpoint
CREATE INDEX "runs_session" ON "runs" USING btree ("session_id") WHERE "runs"."session_id" is not null;
