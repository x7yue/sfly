ALTER TABLE "feishu_bots" ADD COLUMN "last_delivery_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "feishu_bots" ADD COLUMN "last_delivery_ok" boolean;--> statement-breakpoint
ALTER TABLE "feishu_bots" ADD COLUMN "last_delivery_error" text;--> statement-breakpoint
ALTER TABLE "feishu_messages" ADD COLUMN "next_attempt_at" timestamp with time zone;