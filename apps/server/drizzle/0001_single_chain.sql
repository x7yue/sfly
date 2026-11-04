CREATE TABLE "agents" (
	"name" text PRIMARY KEY NOT NULL,
	"info" jsonb NOT NULL,
	"status" text NOT NULL,
	"registered_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL
);
