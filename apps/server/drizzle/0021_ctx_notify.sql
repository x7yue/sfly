-- ctx.notify（#234，ADR 0020）：派发时随任务下发的机器人名单记在任务上，节点发通知时据此检查。
ALTER TABLE "tasks" ADD COLUMN "referenced_feishu_bots" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
-- 控制面也往任务日志里写行（source system），日志序号由控制面分配；Agent 的序号只用来给 Agent 上报的行去重，
-- 单独记下（src/logs/task-logs.ts）。已有的任务日志里没有控制面写的行（截断标记沿用被丢弃那一行的序号），
-- 两种序号相同。
ALTER TABLE "tasks" ADD COLUMN "log_agent_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "tasks" SET "log_agent_seq" = "log_seq";
