CREATE TABLE "agents" (
	"name" text PRIMARY KEY NOT NULL,
	"info" jsonb NOT NULL,
	"status" text NOT NULL,
	"registered_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chain_instances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"chain_id" text NOT NULL,
	"parent_chain_instance_id" uuid,
	"async_node_id" text,
	"depth" integer NOT NULL,
	"params" jsonb NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "orchestration_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"orchestration_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"document" jsonb NOT NULL,
	"author" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "orchestration_versions_number" UNIQUE("orchestration_id","number")
);
--> statement-breakpoint
CREATE TABLE "orchestrations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"head_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"orchestration_id" uuid NOT NULL,
	"orchestration_version_id" uuid NOT NULL,
	"triggered_by" text NOT NULL,
	"params" jsonb NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"chain_instance_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"agent_name" text,
	"status" text NOT NULL,
	"inputs" jsonb,
	"outputs" jsonb,
	"error_kind" text,
	"error_message" text,
	"queued_at" timestamp with time zone NOT NULL,
	"seq" bigserial NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	CONSTRAINT "tasks_attempt" UNIQUE("chain_instance_id","node_id","attempt")
);
--> statement-breakpoint
ALTER TABLE "chain_instances" ADD CONSTRAINT "chain_instances_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orchestration_versions" ADD CONSTRAINT "orchestration_versions_orchestration_id_orchestrations_id_fk" FOREIGN KEY ("orchestration_id") REFERENCES "public"."orchestrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_orchestration_id_orchestrations_id_fk" FOREIGN KEY ("orchestration_id") REFERENCES "public"."orchestrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_orchestration_version_id_orchestration_versions_id_fk" FOREIGN KEY ("orchestration_version_id") REFERENCES "public"."orchestration_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_chain_instance_id_chain_instances_id_fk" FOREIGN KEY ("chain_instance_id") REFERENCES "public"."chain_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chain_instances_run" ON "chain_instances" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "runs_orchestration" ON "runs" USING btree ("orchestration_id");--> statement-breakpoint
CREATE INDEX "tasks_agent_status" ON "tasks" USING btree ("agent_name","status");--> statement-breakpoint
CREATE INDEX "tasks_chain_instance" ON "tasks" USING btree ("chain_instance_id");