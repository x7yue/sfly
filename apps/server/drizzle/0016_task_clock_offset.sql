-- 任务开始和结束时的时钟偏差（Agent 时间 − 控制面时间，毫秒）和它对应的控制面时间（#175）；旧版 Agent 或旧任务为空。
ALTER TABLE "tasks" ADD COLUMN "start_clock_offset_ms" bigint;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "start_clock_offset_measured_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "end_clock_offset_ms" bigint;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "end_clock_offset_measured_at" timestamp with time zone;