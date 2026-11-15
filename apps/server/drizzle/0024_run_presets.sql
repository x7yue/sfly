CREATE TABLE "run_presets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"orchestration_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"values" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "run_presets_name" UNIQUE("orchestration_id","name")
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "preset_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "preset_name" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "preset_params" jsonb;--> statement-breakpoint
ALTER TABLE "run_presets" ADD CONSTRAINT "run_presets_orchestration_id_orchestrations_id_fk" FOREIGN KEY ("orchestration_id") REFERENCES "public"."orchestrations"("id") ON DELETE no action ON UPDATE no action;