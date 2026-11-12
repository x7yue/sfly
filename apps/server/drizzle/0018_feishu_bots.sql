CREATE TABLE "feishu_bots" (
	"name" text PRIMARY KEY NOT NULL,
	"webhook_url" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
