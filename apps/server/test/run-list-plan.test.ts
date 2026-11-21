// 运行记录按场景筛选不能因为带了项目条件而变慢（规格 #487 的审查）：`GET /runs?orchestration_id=…` 的查询带着
// `project_id` 条件、按开始时间倒序取前 N 条，规划器可以倒着扫 `runs_project_started`、一行行过滤场景
// （一个场景只有很少的运行、又都是最早的，要扫过整个项目的运行）。`runs_orchestration` 是
// `(orchestration_id, started_at, id)` 的复合索引，先取出这个场景的运行再排序。
//
// 测试量的是执行计划里 runs 表被扫过的行数（返回的加上被过滤掉的），不量耗时：一个场景 30 个运行，
// 项目里有几十万个，扫过的行数不该随项目的运行总数增长。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { DEFAULT_PROJECT } from "../src/projects/project-id.js";
import { listAllRuns } from "../src/runs/run-list.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

/** 项目里运行的总数，和目标场景的运行数（都是最早的运行）。 */
const TOTAL_RUNS = 300_000;
const TARGET_RUNS = 30;
/** 计划里 runs 表被扫过的行数上限：目标场景只有 30 个运行，留出余量。 */
const SCANNED_LIMIT = 1_000;

interface PlanNode {
	"Node Type": string;
	"Relation Name"?: string;
	"Index Name"?: string;
	"Actual Rows"?: number;
	"Actual Loops"?: number;
	"Rows Removed by Filter"?: number;
	Plans?: PlanNode[];
}

/** 计划里每个扫描 runs 表的节点：扫过的行数（返回的加上被过滤掉的，乘上循环次数）和用到的索引。 */
function scansOfRuns(node: PlanNode): { rows: number; index: string | undefined }[] {
	const own =
		node["Relation Name"] === "runs"
			? [
					{
						rows:
							((node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0)) *
							(node["Actual Loops"] ?? 1),
						index: node["Index Name"],
					},
				]
			: [];
	return [...own, ...(node.Plans ?? []).flatMap(scansOfRuns)];
}

describe("运行记录按场景筛选的执行计划", () => {
	let testDb: TestDatabase;
	let database: ReturnType<typeof openDatabase>;
	let target: string;

	beforeAll(async () => {
		testDb = await createTestDatabase();
		database = openDatabase(testDb.url, () => {});
		await database.migrate();
		const { pool } = database;
		// 200 个场景：目标场景（编号 0）只有 30 个运行，而且最早；其余 199 个场景平分其余的运行，都比它晚。
		// 场景多、每个都不少，目标场景的运行数才不会被统计信息单独认出来：规划器估计它和别的场景差不多多，
		// 倒着扫项目的索引取前 N 个看起来就比先取这个场景的运行再排序便宜。
		await pool.query(
			`insert into orchestrations (id, project_id, name, head_version, created_at)
			select gen_random_uuid(), 'default', '场景' || lpad(g::text, 3, '0'), 1, now() from generate_series(0, 199) g`,
		);
		await pool.query(
			`insert into orchestration_versions (id, orchestration_id, number, document, author, created_at)
			select gen_random_uuid(), id, 1, '{"nodes":[],"edges":[],"packages":{}}', '测试', now() from orchestrations`,
		);
		await pool.query(
			`create temp table seeded as
			select (row_number() over (order by o.name) - 1)::int as n, o.id, v.id as version
			from orchestrations o join orchestration_versions v on v.orchestration_id = o.id`,
		);
		const first = (await pool.query<{ id: string }>("select id from seeded where n = 0")).rows[0];
		if (!first) throw new Error("没有种出场景");
		target = first.id;
		await pool.query(
			`insert into runs (id, orchestration_id, orchestration_version_id, project_id, triggered_by, params, status, started_at, ended_at)
			select gen_random_uuid(), s.id, s.version, 'default', '测试', '{}', 'success',
				timestamp '2020-01-01' + g * interval '1 minute', timestamp '2020-01-01' + g * interval '1 minute'
			from generate_series(1, $1) g join seeded s on s.n = 0`,
			[TARGET_RUNS],
		);
		await pool.query(
			`insert into runs (id, orchestration_id, orchestration_version_id, project_id, triggered_by, params, status, started_at, ended_at)
			select gen_random_uuid(), s.id, s.version, 'default', '测试', '{}', (array['success','failed','cancelled'])[1 + g % 3],
				timestamp '2026-01-01' + g * interval '1 second', timestamp '2026-01-01' + g * interval '1 second'
			from generate_series(1, $1) g join seeded s on s.n = 1 + g % 199`,
			[TOTAL_RUNS - TARGET_RUNS],
		);
		await pool.query("analyze runs");
	}, 120_000);

	afterAll(async () => {
		await database.close();
		await testDb.drop();
	});

	/** 执行 `run` 期间发给数据库的语句（文本和参数）。 */
	async function captured(run: () => Promise<unknown>) {
		const statements: { text: string; values: unknown[] }[] = [];
		const original = database.pool.query.bind(database.pool) as (...args: unknown[]) => unknown;
		(database.pool as unknown as { query: unknown }).query = (...args: unknown[]) => {
			// drizzle 调 `query(配置, 参数)`：参数在第二个位置，也可能在配置里。
			const config = args[0] as { text?: string; values?: unknown[] } | string;
			const text = typeof config === "string" ? config : config.text;
			const values = Array.isArray(args[1])
				? args[1]
				: typeof config === "object"
					? (config.values ?? [])
					: [];
			if (text) statements.push({ text, values });
			return original(...args);
		};
		try {
			await run();
		} finally {
			(database.pool as unknown as { query: unknown }).query = original;
		}
		return statements;
	}

	/** 这次 `listAllRuns` 里带着项目条件查 runs 的每条语句，在真实数据上执行的计划里 runs 表被扫过的行数。 */
	async function scanned(filter: Parameters<typeof listAllRuns>[2]) {
		const statements = await captured(() => listAllRuns(database.db, DEFAULT_PROJECT, filter));
		const mine = statements.filter(
			(s) => /from "runs"/.test(s.text) && s.text.includes('"project_id"'),
		);
		expect(mine.length, "带项目条件的查询").toBeGreaterThanOrEqual(2);
		const results: { text: string; rows: number; indexes: (string | undefined)[] }[] = [];
		for (const s of mine) {
			const { rows } = await database.pool.query<{ "QUERY PLAN": [{ Plan: PlanNode }] }>({
				text: `explain (analyze, format json) ${s.text}`,
				values: s.values,
			});
			const scans = scansOfRuns(rows[0]?.["QUERY PLAN"][0]?.Plan as PlanNode);
			results.push({
				text: s.text.replace(/\s+/g, " ").slice(0, 120),
				rows: scans.reduce((sum, scan) => sum + scan.rows, 0),
				indexes: scans.map((scan) => scan.index),
			});
		}
		return results;
	}

	it("按场景筛选：一个场景只有 30 个运行、都是最早的，项目里有 200 个场景、30 万个运行，扫过的行数和项目的运行总数无关", async () => {
		const results = await scanned({ orchestrationId: target, limit: 50 });
		for (const r of results) {
			expect(r.rows, `${r.text}（用到的索引：${r.indexes.join("、")}）`).toBeLessThanOrEqual(
				SCANNED_LIMIT,
			);
		}
	});

	it("按场景加状态、按场景加关键字筛选同样不扫整个项目", async () => {
		for (const filter of [
			{ orchestrationId: target, status: "success" as const, limit: 50 },
			{ orchestrationId: target, q: "测试", limit: 50 },
		]) {
			for (const r of await scanned(filter)) {
				expect(r.rows, r.text).toBeLessThanOrEqual(SCANNED_LIMIT);
			}
		}
	});

	it("对照：不按场景筛选时取前 50 个运行倒着扫 runs_project_started，扫的行数和项目的运行总数无关（只取 50 个）", async () => {
		const results = await scanned({ limit: 50 });
		const page = results.find((r) => r.indexes.includes("runs_project_started"));
		expect(page, "取前 50 个用项目索引").toBeDefined();
		expect(page?.rows).toBeLessThanOrEqual(SCANNED_LIMIT);
	});
});
