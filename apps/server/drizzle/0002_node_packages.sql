CREATE TABLE "node_packages" (
	"name" text NOT NULL,
	"version" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"file_path" text NOT NULL,
	"sha256" text NOT NULL,
	"size" bigint NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	CONSTRAINT "node_packages_name_version_pk" PRIMARY KEY("name","version")
);
