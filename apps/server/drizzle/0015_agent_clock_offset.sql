-- Agent 记录上的时钟偏差（Agent 时间 − 控制面时间，毫秒）和测量时刻（#172）；旧版 Agent 不上报时为空。
ALTER TABLE "agents" ADD COLUMN "clock_offset_ms" bigint;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "clock_offset_measured_at" timestamp with time zone;