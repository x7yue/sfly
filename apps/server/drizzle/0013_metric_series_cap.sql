-- 序列上限（#78）：任务的序列数超过上限（1000 个）后记「序列超限」标记，新序列的点被丢弃。
ALTER TABLE "tasks" ADD COLUMN "metric_series_capped" boolean DEFAULT false NOT NULL;
