-- 指标按控制面时间存储，每个点另外保存 Agent 时间（#174，ADR 0018、ADR 0009 修订）。
-- 摘要的 first_at / last_at 改为控制面时间，另加首尾两个点的 Agent 时间；已有的行这两列为空：
-- 它们的 first_at / last_at 是 Agent 时间，控制面时间没有记录。
ALTER TABLE "metric_series" ADD COLUMN "first_agent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "metric_series" ADD COLUMN "last_agent_at" timestamp with time zone;--> statement-breakpoint
-- 分段表手写（声明式分区，见 0008）；对分区表的修改同时作用于所有分区。start_at / end_at / offsets 改为控制面时间，
-- agent_offsets 是每个点的「Agent 时间 − 控制面时间」（秒），全段相同时只存一个元素。已有的段为 NULL：
-- 它们的时间列是 Agent 时间，控制面时间没有记录。
ALTER TABLE "metric_segments" ADD COLUMN "agent_offsets" bigint[];--> statement-breakpoint
ALTER TABLE "metric_segments" ALTER COLUMN "agent_offsets" SET STORAGE MAIN;
