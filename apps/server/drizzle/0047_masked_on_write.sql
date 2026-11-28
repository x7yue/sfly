ALTER TABLE "runs" ADD COLUMN "masked_on_write" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "secrets_oversize" boolean DEFAULT false NOT NULL;