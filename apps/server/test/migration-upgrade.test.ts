// 迁移的升级场景（#518）：drizzle 只执行 `_journal.json` 里 `when` 比库里最后一个已执行迁移新的，比的不是编号。
// 几个 PR 同时加迁移、后合入的一方重新排号时，只改编号不改 `when`，这个迁移在已经执行过前一条的库上会被静默跳过，
// 而 CI 每次从空库开始、抓不到。这里先迁到倒数第二个，再执行全部，确认最后一个确实被执行了。
// 对「最后一个」通用，不写死编号：以后加迁移时它照样检查新加的那个。不连数据库的检查在 scripts/check_migrations.py。
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { defaultMigrationsDir, openDatabase } from "../src/db/database.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

interface JournalEntry {
	idx: number;
	tag: string;
	when: number;
}

let database: TestDatabase;
let workDir: string;

beforeAll(async () => {
	database = await createTestDatabase("sfly_migrate");
	workDir = await mkdtemp(join(tmpdir(), "sfly-migration-upgrade-"));
});
afterAll(async () => {
	await database?.drop();
	if (workDir) await rm(workDir, { recursive: true, force: true });
});

const readJournal = async (dir: string) =>
	JSON.parse(await readFile(join(dir, "meta", "_journal.json"), "utf8")) as {
		entries: JournalEntry[];
	};

/** 数据库里 drizzle 记下的已执行迁移的 `when`（`created_at`），按执行的先后。 */
async function appliedWhens(): Promise<number[]> {
	const client = new pg.Client({ connectionString: database.url });
	await client.connect();
	try {
		const { rows } = await client.query<{ created_at: string }>(
			"select created_at from drizzle.__drizzle_migrations order by id",
		);
		return rows.map((row) => Number(row.created_at));
	} finally {
		await client.end();
	}
}

/** 用指定的迁移目录对测试库执行迁移（和控制面启动时一样：`openDatabase(...).migrate()`）。 */
async function migrateWith(dir: string) {
	const db = openDatabase(
		database.url,
		(error) => {
			throw error;
		},
		dir,
	);
	try {
		await db.migrate();
	} finally {
		await db.close();
	}
}

it("先迁到倒数第二个迁移，再执行全部：最后一个迁移被执行了，不被静默跳过", async () => {
	const { entries } = await readJournal(defaultMigrationsDir);
	expect(entries.length).toBeGreaterThan(1);
	const last = entries.at(-1) as JournalEntry;
	const previous = entries.at(-2) as JournalEntry;

	// 只含倒数第二个及之前的迁移的目录：日志去掉最后一条，SQL 和快照也去掉。
	const partial = join(workDir, "partial");
	await cp(defaultMigrationsDir, partial, { recursive: true });
	const journal = await readJournal(partial);
	journal.entries = journal.entries.filter((entry) => entry.idx !== last.idx);
	await writeFile(join(partial, "meta", "_journal.json"), JSON.stringify(journal));
	await rm(join(partial, `${last.tag}.sql`));
	await rm(join(partial, "meta", `${String(last.idx).padStart(4, "0")}_snapshot.json`));
	expect((await readdir(partial)).filter((name) => name.endsWith(".sql"))).toHaveLength(
		entries.length - 1,
	);

	await migrateWith(partial);
	expect((await appliedWhens()).at(-1)).toBe(previous.when);
	expect(await appliedWhens()).toHaveLength(entries.length - 1);

	// 升级：执行全部迁移。最后一个迁移要被执行，库里记下它的 when。
	await migrateWith(defaultMigrationsDir);
	const applied = await appliedWhens();
	expect(
		applied,
		`${last.tag} 没有被执行：它的 when（${last.when}）比 ${previous.tag} 的小？`,
	).toEqual(entries.map((entry) => entry.when));
});
