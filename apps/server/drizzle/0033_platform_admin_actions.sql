CREATE TABLE "platform_admin_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"route" text NOT NULL,
	"resource_kind" text NOT NULL,
	"resource_id" text,
	"token_name" text
);
--> statement-breakpoint
ALTER TABLE "platform_admin_actions" ADD CONSTRAINT "platform_admin_actions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_admin_actions" ADD CONSTRAINT "platform_admin_actions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_admin_actions_project" ON "platform_admin_actions" USING btree ("project_id","at");