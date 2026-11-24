-- 任务凭据记下派发时连接用的那一个 Agent 凭据（#492）：任务凭据只在它没被吊销时有效。这一列加进来之前派发的任务凭据留空，
-- 按「连接用的是旧方式」处理（只看这台 Agent 有没有停用），随租约过期自然失效；不回填（凭据只是短命的，没有需要保住的记录）。
ALTER TABLE "api_tokens" ADD COLUMN "agent_credential_id" uuid;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_agent_credential_id_agent_credentials_id_fk" FOREIGN KEY ("agent_credential_id") REFERENCES "public"."agent_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_agent_credential_task" CHECK ("api_tokens"."agent_credential_id" is null or "api_tokens"."kind" = 'task');