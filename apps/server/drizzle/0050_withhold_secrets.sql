ALTER TABLE "runs" ADD COLUMN "secrets_withheld" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "use_project_secrets" boolean DEFAULT false NOT NULL;