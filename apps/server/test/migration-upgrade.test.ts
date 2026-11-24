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

it("会话令牌组合外键的迁移（#547）：项目和所属会话对不上的旧令牌行在加约束之前被清掉，一致的留下，升级不失败", async () => {
	const upgradeDb = await createTestDatabase("sfly_migrate_tokens");
	try {
		const { entries } = await readJournal(defaultMigrationsDir);
		const target = entries.find((entry) => entry.tag === "0038_session_provenance");
		expect(target, "找不到 0038_session_provenance：迁移改了编号，这条测试跟着改").toBeDefined();
		const before = (target as JournalEntry).idx - 1;

		// 只含 0038 之前的迁移的目录：旧版控制面的库。
		const partial = join(workDir, "before-0038");
		await cp(defaultMigrationsDir, partial, { recursive: true });
		const journal = await readJournal(partial);
		journal.entries = journal.entries.filter((entry) => entry.idx <= before);
		await writeFile(join(partial, "meta", "_journal.json"), JSON.stringify(journal));
		const run = async (dir: string) => {
			const db = openDatabase(
				upgradeDb.url,
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
		};
		await run(partial);

		const client = new pg.Client({ connectionString: upgradeDb.url });
		await client.connect();
		try {
			const user = "11111111-1111-4111-8111-111111111111";
			const session = "22222222-2222-4222-8222-222222222222";
			await client.query(
				`insert into users (id, login_name, display_name, password_hash, created_at)
				values ($1, 'alice', 'Alice', 'x', now())`,
				[user],
			);
			await client.query(
				"insert into projects (id, display_name, created_at) values ('beta', 'beta', now())",
			);
			await client.query(
				`insert into sessions (id, project_id, title, status, created_by, created_by_user_id, created_at, last_activity_at)
				values ($1, 'default', 's', 'idle', 'alice', $2, now(), now())`,
				[session, user],
			);
			// 旧约束只看会话在不在，不看项目：一行一致（默认项目），一行对不上（令牌说是 beta，会话在默认项目）。
			const token = (id: string, project: string, hash: string) =>
				client.query(
					`insert into api_tokens (id, kind, name, prefix, token_hash, user_id, project_id, session_id, scopes, created_at)
					values ($1, 'session', 't', 'sfly_ses_', $2, $3, $4, $5, '{read}', now())`,
					[id, hash, user, project, session],
				);
			await token("33333333-3333-4333-8333-333333333333", "default", "hash-consistent");
			await token("44444444-4444-4444-8444-444444444444", "beta", "hash-mismatched");
		} finally {
			await client.end();
		}

		await run(defaultMigrationsDir);

		const after = new pg.Client({ connectionString: upgradeDb.url });
		await after.connect();
		try {
			const rows = await after.query<{ token_hash: string }>(
				"select token_hash from api_tokens order by token_hash",
			);
			expect(rows.rows.map((r) => r.token_hash)).toEqual(["hash-consistent"]);
			// 约束在，对不上的行写不进去。
			await expect(
				after.query(
					`insert into api_tokens (id, kind, name, prefix, token_hash, user_id, project_id, session_id, scopes, created_at)
					values (gen_random_uuid(), 'session', 't', 'sfly_ses_', 'again', '11111111-1111-4111-8111-111111111111', 'beta', '22222222-2222-4222-8222-222222222222', '{read}', now())`,
				),
			).rejects.toThrow(/api_tokens_session_project_fk/);
		} finally {
			await after.end();
		}
	} finally {
		await upgradeDb.drop();
	}
}, 120_000);

it("排队时间的迁移（0039，#544）：从 0038 带着数据升级——排队中而没有排队时间的行补上最近活动的时间，别的状态的行不受影响，之后约束在", async () => {
	const upgradeDb = await createTestDatabase("sfly_migrate_queued");
	try {
		const { entries } = await readJournal(defaultMigrationsDir);
		const target = entries.find((entry) => entry.tag === "0039_session_queued_at");
		expect(target, "找不到 0039_session_queued_at：迁移改了编号，这条测试跟着改").toBeDefined();
		const before = (target as JournalEntry).idx - 1;
		const partial = join(workDir, "before-0039");
		await cp(defaultMigrationsDir, partial, { recursive: true });
		const journal = await readJournal(partial);
		journal.entries = journal.entries.filter((entry) => entry.idx <= before);
		await writeFile(join(partial, "meta", "_journal.json"), JSON.stringify(journal));
		const run = async (dir: string) => {
			const db = openDatabase(
				upgradeDb.url,
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
		};
		await run(partial);

		const rows = {
			idle: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
			running: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
			queued: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
			queuedLater: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
			ended: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5",
		};
		const client = new pg.Client({ connectionString: upgradeDb.url });
		await client.connect();
		try {
			// 这一列在 0038 里还不存在：升级之前的库里没有「有排队时间」的行，只有「排队中」的状态（0035 的状态约束允许 `queued`）。
			for (const project of ["p-idle", "p-running", "p-queued", "p-ended"]) {
				await client.query(
					"insert into projects (id, display_name, created_at) values ($1, $1, now())",
					[project],
				);
			}
			const add = (id: string, project: string, status: string, activity: string) =>
				client.query(
					`insert into sessions (id, project_id, title, status, created_by, created_at, last_activity_at, current_turn)
					values ($1, $2, 's', $3, 'alice', '2026-01-01T00:00:00Z', $4, 1)`,
					[id, project, status, activity],
				);
			await add(rows.idle, "p-idle", "idle", "2026-01-01T00:01:00Z");
			await add(rows.running, "p-running", "running", "2026-01-01T00:02:00Z");
			await add(rows.queued, "p-queued", "queued", "2026-01-01T00:03:00Z");
			await add(rows.queuedLater, "p-queued", "queued", "2026-01-01T00:04:00Z");
			await add(rows.ended, "p-ended", "ended", "2026-01-01T00:05:00Z");
		} finally {
			await client.end();
		}

		await run(defaultMigrationsDir);

		const after = new pg.Client({ connectionString: upgradeDb.url });
		await after.connect();
		try {
			const read = await after.query<{
				id: string;
				status: string;
				queued_at: Date | null;
				at: Date;
			}>("select id, status, queued_at, last_activity_at as at from sessions order by id");
			const byId = new Map(read.rows.map((r) => [r.id, r]));
			// 排队中的补上最近活动的时间（先后不变），别的状态没有。
			expect(byId.get(rows.queued)?.queued_at?.toISOString()).toBe("2026-01-01T00:03:00.000Z");
			expect(byId.get(rows.queuedLater)?.queued_at?.toISOString()).toBe("2026-01-01T00:04:00.000Z");
			for (const id of [rows.idle, rows.running, rows.ended]) {
				expect(byId.get(id)?.queued_at, id).toBeNull();
			}
			// 数据原样：状态没变。
			expect(read.rows.map((r) => r.status)).toEqual(
				read.rows.map(
					(r) =>
						({
							[rows.idle]: "idle",
							[rows.running]: "running",
							[rows.queued]: "queued",
							[rows.queuedLater]: "queued",
							[rows.ended]: "ended",
						})[r.id],
				),
			);
			// 约束在：空闲、已结束的不能有，排队中的一定有，在做的可以有。
			await expect(
				after.query("update sessions set queued_at = now() where id = $1", [rows.idle]),
			).rejects.toThrow(/sessions_queued_at/);
			await expect(
				after.query("update sessions set queued_at = null where id = $1", [rows.queued]),
			).rejects.toThrow(/sessions_queued_at/);
			await after.query("update sessions set queued_at = now() where id = $1", [rows.running]);
			const index = await after.query(
				"select 1 from pg_indexes where indexname = 'sessions_project_queue'",
			);
			expect(index.rowCount).toBe(1);
		} finally {
			await after.end();
		}
	} finally {
		await upgradeDb.drop();
	}
}, 120_000);
