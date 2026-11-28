CREATE TABLE "package_version_conflicts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"stage" text NOT NULL,
	"project_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"package" text NOT NULL,
	"version" text NOT NULL,
	"message" text NOT NULL,
	CONSTRAINT "package_version_conflicts_stage" CHECK ("package_version_conflicts"."stage" in ('trigger', 'dispatch'))
);
--> statement-breakpoint
CREATE INDEX "package_version_conflicts_at" ON "package_version_conflicts" USING btree ("at");