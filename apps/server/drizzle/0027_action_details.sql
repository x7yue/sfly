CREATE TABLE "task_action_names" (
	"task_id" uuid NOT NULL,
	"name" text NOT NULL,
	"stored" integer DEFAULT 0 NOT NULL,
	"dropped" integer DEFAULT 0 NOT NULL,
	"dropped_from" timestamp with time zone,
	"agent_dropped_from" timestamp with time zone,
	CONSTRAINT "task_action_names_task_id_name_pk" PRIMARY KEY("task_id","name")
);
--> statement-breakpoint
CREATE TABLE "task_actions" (
	"task_id" uuid NOT NULL,
	"id" bigint NOT NULL,
	"kind" text NOT NULL,
	"parent" bigint,
	"depth" integer NOT NULL,
	"name" text NOT NULL,
	"fields" json NOT NULL,
	"noted" json,
	"started_at" timestamp with time zone NOT NULL,
	"agent_started_at" timestamp with time zone NOT NULL,
	"start_mono" bigint NOT NULL,
	"ended_at" timestamp with time zone,
	"agent_ended_at" timestamp with time zone,
	"duration_ms" bigint,
	"result" text,
	"reason" text,
	"rev" bigint NOT NULL,
	CONSTRAINT "task_actions_task_id_id_pk" PRIMARY KEY("task_id","id")
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "action_details" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "action_rev" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "action_capped" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "task_action_names" ADD CONSTRAINT "task_action_names_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_actions_started" ON "task_actions" USING btree ("task_id","started_at","id");--> statement-breakpoint
CREATE INDEX "task_actions_name" ON "task_actions" USING btree ("task_id","name","started_at","id");--> statement-breakpoint
CREATE INDEX "task_actions_failed" ON "task_actions" USING btree ("task_id","started_at","id") WHERE "task_actions"."result" = 'failed';--> statement-breakpoint
CREATE INDEX "task_actions_rev" ON "task_actions" USING btree ("task_id","rev","id");