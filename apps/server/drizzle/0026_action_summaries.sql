CREATE TABLE "task_action_summaries" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"summary" jsonb NOT NULL,
	"current_action" jsonb
);
--> statement-breakpoint
ALTER TABLE "task_action_summaries" ADD CONSTRAINT "task_action_summaries_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;