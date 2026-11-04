CREATE TABLE "agents" (
	"name" text PRIMARY KEY NOT NULL,
	"info" jsonb NOT NULL,
	"status" text NOT NULL,
	"registered_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL
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
ALTER TABLE "orchestration_versions" ADD CONSTRAINT "orchestration_versions_orchestration_id_orchestrations_id_fk" FOREIGN KEY ("orchestration_id") REFERENCES "public"."orchestrations"("id") ON DELETE no action ON UPDATE no action;