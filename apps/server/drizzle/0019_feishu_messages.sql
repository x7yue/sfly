CREATE TABLE "feishu_messages" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"bot_name" text NOT NULL,
	"source" text NOT NULL,
	"run_id" uuid,
	"task_id" uuid,
	"body" jsonb NOT NULL,
	"enqueued_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "feishu_messages" ADD CONSTRAINT "feishu_messages_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feishu_messages" ADD CONSTRAINT "feishu_messages_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feishu_messages_queued" ON "feishu_messages" USING btree ("bot_name","seq") WHERE "feishu_messages"."status" = 'queued';