ALTER TABLE "chain_instances" ADD COLUMN "stop_task_id" uuid;--> statement-breakpoint
ALTER TABLE "chain_instances" ADD COLUMN "stop_requested_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "chain_instances_stop_task" ON "chain_instances" USING btree ("stop_task_id");