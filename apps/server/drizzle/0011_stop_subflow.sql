ALTER TABLE "chain_instances" ADD COLUMN "stop_task_id" uuid;--> statement-breakpoint
ALTER TABLE "chain_instances" ADD COLUMN "stop_requested_at" timestamp with time zone;