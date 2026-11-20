CREATE TABLE "agent_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"project_id" text NOT NULL,
	"agent_name" text,
	"prefix" text,
	"token_hash" text NOT NULL,
	"user_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "agent_credentials_hash" UNIQUE("token_hash"),
	CONSTRAINT "agent_credentials_kind" CHECK ("agent_credentials"."kind" in ('agent', 'shared')),
	CONSTRAINT "agent_credentials_shape" CHECK (("agent_credentials"."kind" = 'agent' and "agent_credentials"."agent_name" is not null and "agent_credentials"."prefix" is not null)
				or ("agent_credentials"."kind" = 'shared' and "agent_credentials"."agent_name" is null and "agent_credentials"."user_id" is null))
);
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid,
	"project_id" text,
	"session_id" uuid,
	"task_id" uuid,
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "api_tokens_hash" UNIQUE("token_hash"),
	CONSTRAINT "api_tokens_kind" CHECK ("api_tokens"."kind" in ('personal', 'project', 'session', 'task')),
	CONSTRAINT "api_tokens_shape" CHECK (("api_tokens"."kind" = 'personal' and "api_tokens"."user_id" is not null and "api_tokens"."session_id" is null and "api_tokens"."task_id" is null)
				or ("api_tokens"."kind" = 'project' and "api_tokens"."project_id" is not null and "api_tokens"."user_id" is null and "api_tokens"."session_id" is null and "api_tokens"."task_id" is null)
				or ("api_tokens"."kind" = 'session' and "api_tokens"."user_id" is not null and "api_tokens"."project_id" is not null and "api_tokens"."session_id" is not null and "api_tokens"."task_id" is null)
				or ("api_tokens"."kind" = 'task' and "api_tokens"."project_id" is not null and "api_tokens"."task_id" is not null and "api_tokens"."user_id" is null and "api_tokens"."session_id" is null))
);
--> statement-breakpoint
CREATE TABLE "logins" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"cookie_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "logins_cookie_hash" UNIQUE("cookie_hash")
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"project_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "project_members_project_id_user_id_pk" PRIMARY KEY("project_id","user_id"),
	CONSTRAINT "project_members_role" CHECK ("project_members"."role" in ('read_only', 'editor', 'project_admin'))
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "projects_id_format" CHECK ("projects"."id" ~ '^[a-z0-9][a-z0-9-]{0,62}$')
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"login_name" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text,
	"disabled_at" timestamp with time zone,
	"is_platform_admin" boolean DEFAULT false NOT NULL,
	"external_identity" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "users_login_name" UNIQUE("login_name"),
	CONSTRAINT "users_login_name_format" CHECK ("users"."login_name" ~ '^[a-z0-9_]{1,32}$'),
	CONSTRAINT "users_can_authenticate" CHECK ("users"."password_hash" is not null or "users"."external_identity" is not null)
);
--> statement-breakpoint
-- 默认项目和公共项目（ADR 0029）：现有的数据都进默认项目；已发布的标准节点包版本进公共项目。可以重复执行。
INSERT INTO "projects" ("id", "display_name", "created_at") VALUES
	('default', '默认项目', now()),
	('public', '公共项目', now())
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
-- 根资源加 project_id：带常量默认值地加非空列，PostgreSQL 只改目录、不重写表（runs 是大表），
-- 现有的行读出来就是默认项目；随后去掉默认值，之后新建的行必须自己写明项目。
-- 运行的 project_id 和它的场景一致：升级时所有场景都在默认项目里，所以运行也是。
ALTER TABLE "agents" ADD COLUMN "project_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "project_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "feishu_bots" ADD COLUMN "project_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "feishu_bots" ALTER COLUMN "project_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "node_packages" ADD COLUMN "project_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "node_packages" ALTER COLUMN "project_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "orchestrations" ADD COLUMN "project_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "orchestrations" ALTER COLUMN "project_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "project_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "project_id" DROP DEFAULT;--> statement-breakpoint
-- 标准节点包 sfly-std（ADR 0017、GLOSSARY「标准节点包」）的已发布版本放进公共项目。
UPDATE "node_packages" SET "project_id" = 'public' WHERE "name" = 'sfly-std';--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "last_auth_kind" text;--> statement-breakpoint
ALTER TABLE "node_packages" ADD COLUMN "published_by" text;--> statement-breakpoint
ALTER TABLE "node_packages" ADD COLUMN "published_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "node_packages" ADD COLUMN "published_token" text;--> statement-breakpoint
ALTER TABLE "orchestration_versions" ADD COLUMN "author_user_id" uuid;--> statement-breakpoint
ALTER TABLE "orchestration_versions" ADD COLUMN "author_token" text;--> statement-breakpoint
ALTER TABLE "run_presets" ADD COLUMN "updated_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "triggered_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "triggered_token" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cancel_requested_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cancel_requested_token" text;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logins" ADD CONSTRAINT "logins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_credentials_agent" ON "agent_credentials" USING btree ("project_id","agent_name");--> statement-breakpoint
CREATE INDEX "api_tokens_user" ON "api_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "api_tokens_project" ON "api_tokens" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "api_tokens_task" ON "api_tokens" USING btree ("task_id") WHERE "api_tokens"."task_id" is not null;--> statement-breakpoint
CREATE INDEX "logins_user" ON "logins" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "project_members_user" ON "project_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_external_identity" ON "users" USING btree ("external_identity") WHERE "users"."external_identity" is not null;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feishu_bots" ADD CONSTRAINT "feishu_bots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_packages" ADD CONSTRAINT "node_packages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_packages" ADD CONSTRAINT "node_packages_published_by_user_id_users_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orchestration_versions" ADD CONSTRAINT "orchestration_versions_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orchestrations" ADD CONSTRAINT "orchestrations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_presets" ADD CONSTRAINT "run_presets_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_triggered_by_user_id_users_id_fk" FOREIGN KEY ("triggered_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_cancel_requested_by_user_id_users_id_fk" FOREIGN KEY ("cancel_requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runs_project_started" ON "runs" USING btree ("project_id","started_at","id");