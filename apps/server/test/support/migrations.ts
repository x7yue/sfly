import { cp as copy, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { defaultMigrationsDir, openDatabase } from "../../src/db/database.js";

/** drizzle 迁移文件里语句之间的分隔。 */
export const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

/**
 * 迁移目录的一份临时副本（调用方用完删除）：日志里只留编号不大于 `upTo` 的迁移，模拟旧版控制面的库；
 * `edit` 可以改某个迁移文件的内容（例如在末尾加一条会失败的语句，模拟迁移中途出错）。
 */
export async function migrationsCopy(
	options: { upTo?: number; edit?: Record<string, (sql: string) => string> } = {},
): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "sfly-migrations-"));
	await copy(defaultMigrationsDir, dir, { recursive: true });
	if (options.upTo !== undefined) {
		const journalPath = join(dir, "meta", "_journal.json");
		const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
			entries: { idx: number }[];
		};
		const upTo = options.upTo;
		journal.entries = journal.entries.filter((e) => e.idx <= upTo);
		await writeFile(journalPath, JSON.stringify(journal));
	}
	for (const [file, change] of Object.entries(options.edit ?? {})) {
		const path = join(dir, file);
		await writeFile(path, change(await readFile(path, "utf8")));
	}
	return dir;
}

/**
 * 在只含旧迁移的库上启动当前的控制面时，启动就会读写、旧迁移里却没有的表（`registerSharedAgentToken` 读写
 * `agent_credentials`，`bootstrapFirstAdmin` 数 `users`，派发一次任务时 `mintTaskCredential` 写 `api_tokens`，
 * 路径里写了项目的请求在访问检查里核对 `projects` 里有这个项目，#488）：补一个只有列、没有外键的占位（`users` 只留 `id`，
 * 启动只数行；`projects` 只留 `id` 和默认项目这一行；`api_tokens` 列和真表一致，只是没有约束）。
 * 升级前要删掉（{@link dropStartupStubs}），由真正的迁移来建。
 */
export const STARTUP_STUB_SQL = `CREATE TABLE "users" ("id" uuid PRIMARY KEY NOT NULL);
--> statement-breakpoint
CREATE TABLE "projects" ("id" text PRIMARY KEY NOT NULL);
--> statement-breakpoint
INSERT INTO "projects" ("id") VALUES ('default');
--> statement-breakpoint
CREATE TABLE "agent_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"project_id" text NOT NULL,
	"agent_name" text,
	"prefix" text,
	"token_hash" text NOT NULL UNIQUE,
	"user_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"token_hash" text NOT NULL UNIQUE,
	"user_id" uuid,
	"project_id" text,
	"session_id" uuid,
	"task_id" uuid,
	"issued_by_user_id" uuid,
	"agent_credential_id" uuid,
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone
);`;

/** 把 {@link STARTUP_STUB_SQL} 接在迁移目录里最后一个迁移的末尾。 */
export async function appendStartupStubs(dir: string): Promise<void> {
	const journal = JSON.parse(await readFile(join(dir, "meta", "_journal.json"), "utf8")) as {
		entries: { tag: string }[];
	};
	const last = join(dir, `${journal.entries.at(-1)?.tag}.sql`);
	await writeFile(
		last,
		`${await readFile(last, "utf8")}${STATEMENT_BREAKPOINT}\n${STARTUP_STUB_SQL}`,
	);
}

/** 升级之前删掉占位表，让真正的迁移来建。 */
export async function dropStartupStubs(databaseUrl: string): Promise<void> {
	const client = new pg.Client({ connectionString: databaseUrl });
	await client.connect();
	try {
		await client.query('drop table "api_tokens"');
		await client.query('drop table "agent_credentials"');
		await client.query('drop table "users"');
		await client.query('drop table "projects"');
	} finally {
		await client.end();
	}
}

const VAULT_MIGRATION = "0044_run_vaults";
const VAULT_STUB = "sfly-test-stub";

/**
 * 当前的控制面启动时要读加密副本的两张表（`secrets/vault-key.ts`）。在没有这条迁移的旧迁移目录上启动时，先按这个目录迁移，
 * 再补两张带标记的占位表；换回有这条迁移的目录之前删掉占位，由真正的迁移来建。
 */
export async function prepareVaultTables(
	databaseUrl: string,
	dir: string | undefined,
): Promise<void> {
	const journal = JSON.parse(
		await readFile(join(dir ?? defaultMigrationsDir, "meta", "_journal.json"), "utf8"),
	) as { entries: { tag: string }[] };
	const client = new pg.Client({ connectionString: databaseUrl });
	await client.connect();
	try {
		const { rows } = await client.query<{ stub: boolean }>(
			"select coalesce(obj_description(to_regclass('public.vault_key'), 'pg_class') = $1, false) as stub",
			[VAULT_STUB],
		);
		if (rows[0]?.stub) await client.query('drop table "run_vaults"; drop table "vault_key"');
		if (journal.entries.some((e) => e.tag === VAULT_MIGRATION) || dir === undefined) return;
		const opened = openDatabase(databaseUrl, () => {}, dir);
		try {
			await opened.migrate();
		} finally {
			await opened.close();
		}
		await client.query(`CREATE TABLE "vault_key" ("id" smallint PRIMARY KEY DEFAULT 1, "fingerprint" text NOT NULL);
			CREATE TABLE "run_vaults" ("run_id" uuid PRIMARY KEY, "sealed" bytea NOT NULL);
			COMMENT ON TABLE "vault_key" IS '${VAULT_STUB}'`);
	} finally {
		await client.end();
	}
}
