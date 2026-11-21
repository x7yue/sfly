// 用户与项目的第一次迁移（0032，ADR 0029，规格 #487）：在一份带有存量数据的库（升级前的 0000–0031）上执行，
// 现有数据全部落在默认项目里，已发布的标准节点包版本落在公共项目里，运行的项目和它的场景一致；迁移要能重复执行。
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultMigrationsDir, openDatabase } from "../src/db/database.js";
import { migrationsCopy, STATEMENT_BREAKPOINT } from "./support/migrations.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

/** 第一次迁移之前的最后一个迁移。 */
const LAST_BEFORE = 31;
const AT = "2026-01-01T00:00:00Z";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SCENARIOS = { a: id(1), b: id(2), archived: id(3) };
const VERSIONS = { a: id(11), b: id(12) };
const RUNS = [id(21), id(22), id(23), id(24)];

const DOCUMENT = JSON.stringify({
	default_agent: "agent-a",
	nodes: [{ id: "entry", kind: "entry", params: [] }],
	edges: [],
	packages: {},
});
const METADATA = (name: string, version: string) =>
	JSON.stringify({ name, version, requires_python: ">=3.10", nodes: [] });

/** 按升级前的表结构写一批存量数据（场景、版本、预设、运行、Agent、节点包、飞书机器人）。 */
async function seedLegacyData(client: pg.Client) {
	await client.query(
		`insert into agents (name, info, status, registered_at, last_seen_at) values
			('agent-a', '{"agent_version":"0.5.0","os":"linux","arch":"x86_64","slots":4}', 'offline', $1, $1),
			('agent-b', '{"agent_version":"0.5.0","os":"linux","arch":"x86_64","slots":2}', 'offline', $1, $1)`,
		[AT],
	);
	await client.query(
		"insert into feishu_bots (name, webhook_url, created_at) values ('bot-1', 'https://open.feishu.cn/hook/x', $1)",
		[AT],
	);
	await client.query(
		`insert into orchestrations (id, name, description, head_version, created_at, archived_at, focus_edit) values
			($1, '场景甲', '', 1, $4, null, '{"by":"小明","at":"2026-01-01T00:00:00Z","summary":"改了","before":null}'),
			($2, '场景乙', '', 1, $4, null, null),
			($3, '已归档的场景', '', 0, $4, $4, null)`,
		[SCENARIOS.a, SCENARIOS.b, SCENARIOS.archived, AT],
	);
	await client.query(
		`insert into orchestration_versions (id, orchestration_id, number, document, author, author_via, created_at) values
			($1, $3, 1, $5, '旧人', 'claude-code', $6),
			($2, $4, 1, $5, '旧人', null, $6)`,
		[VERSIONS.a, VERSIONS.b, SCENARIOS.a, SCENARIOS.b, DOCUMENT, AT],
	);
	await client.query(
		`insert into run_presets (id, orchestration_id, name, description, values, created_at, updated_at, updated_by)
		values ($1, $2, '预设', '', '{}', $3, $3, '旧人')`,
		[id(31), SCENARIOS.a, AT],
	);
	// 两个场景各有运行；已归档的场景没有运行。
	const runs: [string, string, string, string][] = [
		[RUNS[0] as string, SCENARIOS.a, VERSIONS.a, "success"],
		[RUNS[1] as string, SCENARIOS.a, VERSIONS.a, "failed"],
		[RUNS[2] as string, SCENARIOS.b, VERSIONS.b, "running"],
		[RUNS[3] as string, SCENARIOS.b, VERSIONS.b, "cancelled"],
	];
	for (const [run, scenario, version, status] of runs) {
		await client.query(
			`insert into runs (id, orchestration_id, orchestration_version_id, triggered_by, triggered_via, params, status,
				started_at, cancel_requested_by)
			values ($1, $2, $3, '旧人', 'codex', '{}', $4, $5, $6)`,
			[run, scenario, version, status, AT, status === "cancelled" ? "旧人" : null],
		);
	}
	await client.query(
		`insert into node_packages (name, version, metadata, file_path, sha256, size, published_at) values
			('sfly-std', '0.1.0', $1, 'packages/sfly-std/0.1.0.sflypkg', 'aa', 1, $4),
			('sfly-std', '0.2.0', $2, 'packages/sfly-std/0.2.0.sflypkg', 'bb', 2, $4),
			('bench', '1.0.0', $3, 'packages/bench/1.0.0.sflypkg', 'cc', 3, $4),
			('sfly-std-extras', '1.0.0', $3, 'packages/sfly-std-extras/1.0.0.sflypkg', 'dd', 4, $4)`,
		[METADATA("sfly-std", "0.1.0"), METADATA("sfly-std", "0.2.0"), METADATA("bench", "1.0.0"), AT],
	);
}

describe("第一次迁移：用户与项目（0032，升级前已有数据的库）", () => {
	let testDb: TestDatabase;
	let client: pg.Client | undefined;
	let before: string;
	const dirs: string[] = [];

	const migrate = async (migrationsDir: string) => {
		const database = openDatabase(testDb.url, () => {}, migrationsDir);
		try {
			await database.migrate();
		} finally {
			await database.close();
		}
	};
	/** 当前用例的连接（beforeEach 里建好）。 */
	const db = () => {
		if (!client) throw new Error("beforeEach 还没有建好连接");
		return client;
	};
	const rows = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
		(await db().query<T>(sql, params)).rows;
	const scalar = async (sql: string) => Object.values((await rows(sql))[0] ?? {})[0];

	beforeEach(async () => {
		testDb = await createTestDatabase();
		before = await migrationsCopy({ upTo: LAST_BEFORE });
		dirs.push(before);
		await migrate(before);
		client = new pg.Client({ connectionString: testDb.url });
		await client.connect();
		await seedLegacyData(client);
	});
	afterEach(async () => {
		await client?.end();
		client = undefined;
		await testDb.drop();
		await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it("现有的场景、Agent、节点包、飞书机器人和运行全部属于默认项目，标准节点包属于公共项目", async () => {
		await migrate(defaultMigrationsDir);

		expect(await rows("select id, display_name from projects order by id")).toEqual([
			{ id: "default", display_name: "默认项目" },
			{ id: "public", display_name: "公共项目" },
		]);
		for (const table of ["orchestrations", "agents", "feishu_bots", "runs"]) {
			expect(await rows(`select distinct project_id from ${table}`), table).toEqual([
				{ project_id: "default" },
			]);
		}
		expect(await scalar("select count(*)::int from orchestrations")).toBe(3);
		expect(await scalar("select count(*)::int from agents")).toBe(2);
		expect(await scalar("select count(*)::int from feishu_bots")).toBe(1);
		expect(await scalar("select count(*)::int from runs")).toBe(4);

		// 标准节点包 sfly-std 的每个已发布版本在公共项目里；名字只是以它开头的、和用户的包都留在默认项目里。
		expect(
			await rows("select name, version, project_id from node_packages order by name, version"),
		).toEqual([
			{ name: "bench", version: "1.0.0", project_id: "default" },
			{ name: "sfly-std", version: "0.1.0", project_id: "public" },
			{ name: "sfly-std", version: "0.2.0", project_id: "public" },
			{ name: "sfly-std-extras", version: "1.0.0", project_id: "default" },
		]);
	});

	it("运行的 project_id 和它的场景一致", async () => {
		await migrate(defaultMigrationsDir);

		expect(
			await scalar(
				`select count(*)::int from runs r join orchestrations o on o.id = r.orchestration_id
				where r.project_id <> o.project_id`,
			),
		).toBe(0);
		expect(await rows("select id from runs where project_id = 'default' order by id")).toHaveLength(
			4,
		);
	});

	it("存量行的原有内容不变，新增的身份列都是空，用户、成员、令牌、登录、Agent 凭据的表是空的", async () => {
		await migrate(defaultMigrationsDir);

		expect(
			await rows(
				`select triggered_by, triggered_via, triggered_by_user_id, triggered_token,
					cancel_requested_by, cancel_requested_by_user_id, cancel_requested_token
				from runs where id = $1`,
				[RUNS[3]],
			),
		).toEqual([
			{
				triggered_by: "旧人",
				triggered_via: "codex",
				triggered_by_user_id: null,
				triggered_token: null,
				cancel_requested_by: "旧人",
				cancel_requested_by_user_id: null,
				cancel_requested_token: null,
			},
		]);
		expect(
			await rows(
				"select author, author_via, author_user_id, author_token from orchestration_versions order by number, id",
			),
		).toEqual([
			{ author: "旧人", author_via: "claude-code", author_user_id: null, author_token: null },
			{ author: "旧人", author_via: null, author_user_id: null, author_token: null },
		]);
		expect(await rows("select updated_by, updated_by_user_id from run_presets")).toEqual([
			{ updated_by: "旧人", updated_by_user_id: null },
		]);
		expect(await rows("select disabled_at, last_auth_kind from agents order by name")).toEqual([
			{ disabled_at: null, last_auth_kind: null },
			{ disabled_at: null, last_auth_kind: null },
		]);
		expect(
			await rows("select published_by, published_by_user_id, published_token from node_packages"),
		).toEqual(
			Array(4).fill({ published_by: null, published_by_user_id: null, published_token: null }),
		);
		// 关注项最后修改的记录原样保留（用户 ID 在 jsonb 里按需要才有）。
		expect(
			await scalar(`select focus_edit->>'by' from orchestrations where id = '${SCENARIOS.a}'`),
		).toBe("小明");
		for (const table of ["users", "project_members", "api_tokens", "logins", "agent_credentials"]) {
			expect(await scalar(`select count(*)::int from ${table}`), table).toBe(0);
		}
	});

	it("项目列不再有默认值：之后新建的根资源必须写明项目，写的项目必须存在", async () => {
		await migrate(defaultMigrationsDir);

		expect(
			await rows(
				`select table_name, column_default, is_nullable from information_schema.columns
				where column_name = 'project_id' and table_name in ('orchestrations', 'agents', 'feishu_bots', 'node_packages', 'runs')
				order by table_name`,
			),
		).toEqual(
			["agents", "feishu_bots", "node_packages", "orchestrations", "runs"].map((table_name) => ({
				table_name,
				column_default: null,
				is_nullable: "NO",
			})),
		);
		await expect(
			db().query(
				"insert into feishu_bots (name, webhook_url, created_at) values ('bot-2', 'https://x', $1)",
				[AT],
			),
		).rejects.toThrow(/null value in column "project_id"/);
		await expect(
			db().query(
				"insert into feishu_bots (name, project_id, webhook_url, created_at) values ('bot-2', 'no-such-project', 'https://x', $1)",
				[AT],
			),
		).rejects.toThrow(/feishu_bots_project_id_projects_id_fk/);
	});

	it("runs 的索引：runs_orchestration 带上开始时间和 ID（运行记录按场景筛选，见 run-list-plan.test.ts），runs_project_started 在", async () => {
		await migrate(defaultMigrationsDir);

		const defs = await rows<{ indexname: string; indexdef: string }>(
			"select indexname, indexdef from pg_indexes where tablename = 'runs' order by indexname",
		);
		const byName = Object.fromEntries(defs.map((d) => [d.indexname, d.indexdef]));
		expect(byName.runs_orchestration).toContain("(orchestration_id, started_at, id)");
		expect(byName.runs_project_started).toContain("(project_id, started_at, id)");
	});

	it("迁移可以重复执行：再执行一次什么都不变，迁移里的种子和回填语句本身也可以重复执行", async () => {
		await migrate(defaultMigrationsDir);
		const snapshot = async () => ({
			projects: await rows("select id, display_name, created_at from projects order by id"),
			packages: await rows(
				"select name, version, project_id from node_packages order by name, version",
			),
			runs: await rows("select id, project_id from runs order by id"),
		});
		const first = await snapshot();

		await migrate(defaultMigrationsDir);
		expect(await snapshot()).toEqual(first);

		// 迁移文件里写数据的语句（建项目、回填公共项目）再执行一遍：不报错，结果不变。
		const sql = await readFile(join(defaultMigrationsDir, "0032_users_and_projects.sql"), "utf8");
		const dataStatements = sql
			.split(STATEMENT_BREAKPOINT)
			.map((statement) => statement.replace(/^(\s*--[^\n]*\n)+/, "").trim())
			.filter((statement) => /^(INSERT|UPDATE)\b/.test(statement));
		expect(dataStatements).toHaveLength(2);
		for (const statement of dataStatements) await db().query(statement);
		expect(await snapshot()).toEqual(first);
	});

	it("迁移中途出错整个回滚，库里没有留下一半：修好之后重新执行成功", async () => {
		const broken = await migrationsCopy({
			edit: {
				"0032_users_and_projects.sql": (sql) => `${sql}${STATEMENT_BREAKPOINT}\nSELECT 1/0;`,
			},
		});
		dirs.push(broken);

		await expect(migrate(broken)).rejects.toThrow();

		// 事务回滚：新表、新列和种子都不在，存量数据原样。
		expect(await scalar("select to_regclass('public.projects')")).toBeNull();
		expect(await scalar("select to_regclass('public.users')")).toBeNull();
		expect(
			await scalar(
				"select count(*)::int from information_schema.columns where table_name = 'runs' and column_name = 'project_id'",
			),
		).toBe(0);
		expect(await scalar("select count(*)::int from runs")).toBe(4);

		await migrate(defaultMigrationsDir);
		expect(await scalar("select count(*)::int from projects")).toBe(2);
		expect(await scalar("select count(*)::int from runs where project_id = 'default'")).toBe(4);
	});

	it("空库（没有存量数据）上也能执行", async () => {
		const empty = await createTestDatabase();
		const database = openDatabase(empty.url, () => {}, defaultMigrationsDir);
		try {
			await database.migrate();
			const check = await database.pool.query("select id from projects order by id");
			expect(check.rows.map((r) => r.id)).toEqual(["default", "public"]);
		} finally {
			await database.close();
			await empty.drop();
		}
	});
});
