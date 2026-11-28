CREATE TABLE "run_vaults" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"sealed" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_key" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"fingerprint" text NOT NULL,
	CONSTRAINT "vault_key_single" CHECK ("vault_key"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "run_vaults" ADD CONSTRAINT "run_vaults_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;