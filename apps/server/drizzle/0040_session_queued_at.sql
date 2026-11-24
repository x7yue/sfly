ALTER TABLE "sessions" ADD COLUMN "queued_at" timestamp with time zone;--> statement-breakpoint
-- 加约束之前先回填：排队中而没有排队时间的行（0035 的状态约束允许 `queued`，之前没有代码写它，有这样的行也不能让升级失败）补上
-- 最近活动的时间；空闲和已结束的行不能有排队时间（这一列是刚加的、都是空的，下面这条只是防御，约束要求的就是它）。
UPDATE "sessions" SET "queued_at" = "last_activity_at" WHERE "status" = 'queued' AND "queued_at" IS NULL;--> statement-breakpoint
UPDATE "sessions" SET "queued_at" = NULL WHERE "status" IN ('idle', 'ended') AND "queued_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "sessions_project_queue" ON "sessions" USING btree ("project_id","queued_at","id") WHERE "sessions"."queued_at" is not null;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_queued_at" CHECK (("sessions"."queued_at" is null and "sessions"."status" <> 'queued') or ("sessions"."queued_at" is not null and "sessions"."status" in ('queued', 'running')));