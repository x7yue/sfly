-- 指标标签（#78，ADR 0009 修订）：序列 = 指标名 + 标签。两张表都加 labels（jsonb，规范形式下内容相同的标签相等）
-- 并放进主键；已有数据成为 labels = '{}' 的序列。删除从未写入过的 ext 列。
ALTER TABLE "metric_series" ADD COLUMN "labels" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "metric_series" DROP CONSTRAINT "metric_series_task_id_metric_pk";--> statement-breakpoint
ALTER TABLE "metric_series" ADD CONSTRAINT "metric_series_task_id_metric_labels_pk" PRIMARY KEY("task_id","metric","labels");--> statement-breakpoint
-- 分段表不在 src/db/schema.ts 里（声明式分区，见 0008），手写；对分区表的修改同时作用于所有分区。
ALTER TABLE "metric_segments" ADD COLUMN "labels" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "metric_segments" DROP CONSTRAINT "metric_segments_pk";--> statement-breakpoint
ALTER TABLE "metric_segments" ADD CONSTRAINT "metric_segments_pk" PRIMARY KEY ("task_id", "metric", "labels", "start_at");--> statement-breakpoint
ALTER TABLE "metric_segments" DROP COLUMN "ext";
