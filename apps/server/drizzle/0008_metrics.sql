CREATE TABLE "metric_series" (
	"task_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"points" integer NOT NULL,
	"min" double precision NOT NULL,
	"max" double precision NOT NULL,
	"sum" double precision NOT NULL,
	"last" double precision NOT NULL,
	"first_at" timestamp with time zone NOT NULL,
	"last_at" timestamp with time zone NOT NULL,
	CONSTRAINT "metric_series_task_id_metric_pk" PRIMARY KEY("task_id","metric")
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "metric_points" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "metric_truncated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "metric_dropped" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "metric_series" ADD CONSTRAINT "metric_series_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_series" ADD CONSTRAINT "metric_series_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "metric_series_run" ON "metric_series" USING btree ("run_id");--> statement-breakpoint
-- 指标原始数据（#29，ADR 0009）：按天分区的分段表，drizzle 不支持声明式分区，所以不在 src/db/schema.ts 里声明。
-- 一行 = 一个任务（尝试）一个指标的一段：时间偏移（秒，相对 start_at）、值、每秒最小 / 最大值的类型化数组，
-- 加上段摘要和预留给序列级扩展信息（例如以后的标签）的 ext。分区由控制面按需创建（WITH toast_tuple_target），
-- 见 src/metrics/task-metrics.ts。
CREATE TABLE "metric_segments" (
	"run_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"offsets" integer[] NOT NULL,
	"values" double precision[] NOT NULL,
	"mins" double precision[] NOT NULL,
	"maxs" double precision[] NOT NULL,
	"points" integer NOT NULL,
	"min" double precision NOT NULL,
	"max" double precision NOT NULL,
	"avg" double precision NOT NULL,
	"last" double precision NOT NULL,
	"ext" jsonb,
	CONSTRAINT "metric_segments_pk" PRIMARY KEY ("task_id", "metric", "start_at")
) PARTITION BY RANGE ("start_at");
--> statement-breakpoint
-- 数组在行内压缩（MAIN）：不移到 TOAST 表，读一段只读一行。
ALTER TABLE "metric_segments"
	ALTER COLUMN "offsets" SET STORAGE MAIN,
	ALTER COLUMN "values" SET STORAGE MAIN,
	ALTER COLUMN "mins" SET STORAGE MAIN,
	ALTER COLUMN "maxs" SET STORAGE MAIN;
--> statement-breakpoint
CREATE INDEX "metric_segments_start_at" ON "metric_segments" USING brin ("start_at");
