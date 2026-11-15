ALTER TABLE "orchestrations" ADD COLUMN "focus_items" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "orchestrations" ADD COLUMN "focus_edit" jsonb;