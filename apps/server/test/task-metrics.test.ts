// 切入点 A：指标上报与存储（#29）。假 Agent 经 gRPC 上报 MetricBatch，
// 通过运行的指标摘要接口 `GET /runs/:id/metrics/summary` 观察。
import { cp as copy, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MetricSummary, metricsApi, type RunMetricSummary } from "@sfly/schema";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultMigrationsDir } from "../src/db/database.js";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { type AssignedTask, FakeAgent, type HelloInit } from "./support/fake-agent.js";
import type { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

/** 2026-01-01T00:00:00Z 之后第 s 秒（Unix 秒）。 */
const at = (s: number) => Date.UTC(2026, 0, 1) / 1000 + s;
const iso = (s: number) => new Date(at(s) * 1000).toISOString();

const ORCHESTRATION = {
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry" },
		{ id: "load", kind: "package", package: "bench", node: "load" },
	],
	edges: [{ from: "entry", to: "load", kind: "chain" }],
	packages: { bench: "1.0.0" },
};

describe("指标上报与存储", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	const agents: FakeAgent[] = [];

	const connect = async (name = "agent-a", devPackages: HelloInit["devPackages"] = []) => {
		const agent = await FakeAgent.connect(cp.grpcUrl, { name, devPackages });
		agents.push(agent);
		return agent;
	};
	const start = async (
		agent: FakeAgent,
		document: unknown = ORCHESTRATION,
	): Promise<{ runId: string; task: AssignedTask }> => {
		const id = await api.orchestrationWith(document);
		const runId = await api.triggerOk(id);
		return { runId, task: await agent.nextAssign() };
	};
	const summary = async (runId: string): Promise<RunMetricSummary> => {
		const res = await cp.fetch(`/runs/${runId}/metrics/summary`);
		expect(res.status).toBe(200);
		return metricsApi.summary.response.parse(await res.json());
	};

	const setup = async (options: Parameters<typeof startTestControlPlane>[0] = {}) => {
		cp = await startTestControlPlane(options);
		api = new ApiClient(cp);
		await publishPackage(cp, "bench", "1.0.0", {
			load: {
				outputs: [],
				metrics: [
					{ name: "tps", unit: "req/s", kind: "gauge" },
					{ name: "requests", unit: "", kind: "counter" },
					{ name: "conn_tps", unit: "req/s", kind: "gauge", labels: ["host", "port"] },
				],
			},
		});
	};

	/** 带标签的点。 */
	const conn = (host: string, t: number, value: number, labels: Record<string, string> = {}) => ({
		name: "conn_tps",
		labels: { host, port: "80", ...labels },
		timeUnixS: BigInt(at(t)),
		value,
		min: value,
		max: value,
	});

	/** 指标名 → 摘要（运行里第一个任务）。 */
	const metricsOf = async (runId: string): Promise<Record<string, MetricSummary>> => {
		const tasks = (await summary(runId)).tasks;
		return Object.fromEntries((tasks[0]?.metrics ?? []).map((m) => [m.name, m]));
	};
	const clock = () => cp.clock as ManualClock;

	beforeEach(async () => setup());
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
	});

	it("任务结束时写入上报的点，摘要给出点数、最小、最大、平均、最新值和首尾时间", async () => {
		const agent = await connect();
		const { runId, task } = await start(agent);
		agent.metrics(task, [
			{ name: "tps", timeUnixS: BigInt(at(1)), value: 10, min: 4, max: 12 },
			{ name: "tps", timeUnixS: BigInt(at(2)), value: 20, min: 20, max: 25 },
			["requests", at(1), 100],
			{ name: "tps", timeUnixS: BigInt(at(3)), value: 30, min: 30, max: 30 },
			["requests", at(3), 250],
		]);
		await agent.succeed(task);

		expect(await summary(runId)).toEqual({
			run_id: runId,
			expired: false,
			tasks: [
				{
					task_id: task.taskId,
					chain_instance_id: expect.any(String),
					node_id: "load",
					attempt: 1,
					truncated: false,
					series_capped: false,
					dropped_points: 0,
					metrics: [
						{
							name: "requests",
							labels: {},
							points: 2,
							min: 100,
							max: 250,
							avg: 175,
							last: 250,
							first_time: iso(1),
							last_time: iso(3),
						},
						{
							name: "tps",
							labels: {},
							points: 3,
							min: 4,
							max: 30,
							avg: 20,
							last: 30,
							first_time: iso(1),
							last_time: iso(3),
						},
					],
				},
			],
		});
	});

	it("同一指标同一秒的重复点（包括重复发送的整批）只算一次", async () => {
		const agent = await connect();
		const { runId, task } = await start(agent);
		const batch: Array<[string, number, number]> = [
			["tps", at(1), 10],
			["tps", at(2), 20],
		];
		agent.metrics(task, batch);
		agent.metrics(task, batch);
		agent.metrics(task, [
			["tps", at(2), 99],
			["tps", at(3), 30],
		]);
		await agent.succeed(task);

		const { tps } = await metricsOf(runId);
		expect(tps).toMatchObject({ points: 3, min: 10, max: 30, avg: 20, last: 30 });
	});

	it("兜底丢弃节点类型没有声明的指标和非有限数值", async () => {
		const agent = await connect();
		const { runId, task } = await start(agent);
		agent.metrics(task, [
			["tps", at(1), 10],
			["typo", at(1), 5],
			["tps", at(2), Number.NaN],
			{ name: "tps", timeUnixS: BigInt(at(3)), value: 1, min: 1, max: Number.POSITIVE_INFINITY },
			["tps", at(4), 40],
		]);
		await agent.succeed(task);

		const metrics = await metricsOf(runId);
		expect(Object.keys(metrics)).toEqual(["tps"]);
		expect(metrics.tps).toMatchObject({ points: 2, min: 10, max: 40, last: 40 });
	});

	it("带标签的点按序列（指标名 + 标签）分别累加，重复按序列判断，控制面重启后接着累计", async () => {
		const agent = await connect();
		const { runId, task } = await start(agent);
		agent.metrics(task, [
			conn("a", 1, 10),
			conn("b", 1, 5),
			conn("a", 2, 20),
			conn("a", 2, 99),
			["tps", at(1), 1],
		]);
		await agent.sync();
		clock().advance(10_000);
		await eventually(async () => {
			expect((await summary(runId)).tasks[0]?.metrics).toHaveLength(3);
		});

		await agent.disconnect();
		agents.splice(0);
		await cp.restart();
		const again = await connect();
		again.metrics(task, [conn("a", 2, 98), conn("b", 2, 6), conn("a", 3, 30)]);
		await again.succeed(task);

		const metrics = (await summary(runId)).tasks[0]?.metrics ?? [];
		expect(metrics.map((m) => [m.name, m.labels, m.points, m.last])).toEqual([
			["conn_tps", { host: "a", port: "80" }, 3, 30],
			["conn_tps", { host: "b", port: "80" }, 2, 6],
			["tps", {}, 1, 1],
		]);
		expect(metrics[0]).toMatchObject({ min: 10, max: 30, avg: 20, first_time: iso(1) });
	});

	it("标签键与节点类型的声明不一致的点被丢弃，计入任务的丢弃数", async () => {
		const agent = await connect();
		const { runId, task } = await start(agent);
		agent.metrics(task, [
			conn("a", 1, 10),
			// 缺少声明过的键（例如旧版 Agent 不认识 labels 字段时，所有键都缺）。
			{ name: "conn_tps", timeUnixS: BigInt(at(2)), value: 1, min: 1, max: 1 },
			{ ...conn("a", 3, 1), labels: { host: "a" } },
			// 带了未声明的键。
			conn("a", 4, 1, { db: "x" }),
			// 给没声明标签键的指标带标签。
			{ name: "tps", labels: { host: "a" }, timeUnixS: BigInt(at(5)), value: 1, min: 1, max: 1 },
			// 值为空或超过 128 个字符。
			conn("", 6, 1),
			conn("x".repeat(129), 7, 1),
			conn("a", 8, 80),
		]);
		await agent.succeed(task);

		const [summaryOfTask] = (await summary(runId)).tasks;
		expect(summaryOfTask).toMatchObject({ dropped_points: 6 });
		expect(summaryOfTask?.metrics.map((m) => [m.name, m.labels, m.points, m.last])).toEqual([
			["conn_tps", { host: "a", port: "80" }, 2, 80],
		]);
	});

	it("每个任务最多 1000 个序列：超出后新序列的点被丢弃并计数，已有序列照常写入；序列超限标记在重启后仍在", async () => {
		const agent = await connect();
		const { runId, task } = await start(agent);
		// 不带标签的 tps、requests 各占 1 个名额（总是能写入），conn_tps 最多 998 个序列。
		agent.metrics(task, [
			...Array.from({ length: 1000 }, (_, i) => conn(`h${i}`, 1, i)),
			["tps", at(1), 1],
		]);
		await agent.sync();
		clock().advance(10_000);
		await eventually(async () => {
			expect((await summary(runId)).tasks[0]?.metrics).toHaveLength(999);
		}, 20_000);

		await agent.disconnect();
		agents.splice(0);
		await cp.restart();
		expect((await summary(runId)).tasks[0]).toMatchObject({
			series_capped: true,
			dropped_points: 2,
		});
		const again = await connect();
		again.metrics(task, [conn("h0", 2, 20), conn("h999", 2, 1), ["requests", at(2), 5]]);
		await again.succeed(task);

		const [summaryOfTask] = (await summary(runId)).tasks;
		expect(summaryOfTask).toMatchObject({
			series_capped: true,
			truncated: false,
			dropped_points: 3,
		});
		const metrics = summaryOfTask?.metrics ?? [];
		expect(metrics).toHaveLength(1000);
		expect(metrics.filter((m) => m.name === "conn_tps")).toHaveLength(998);
		expect(metrics.find((m) => m.labels.host === "h0")).toMatchObject({ points: 2, last: 20 });
		expect(metrics.some((m) => m.labels.host === "h998" || m.labels.host === "h999")).toBe(false);
		expect(metrics.filter((m) => m.name !== "conn_tps").map((m) => [m.name, m.last])).toEqual([
			["requests", 5],
			["tps", 1],
		]);

		const catalog = metricsApi.catalog.response.parse(await api.getJson(`/runs/${runId}/metrics`));
		expect(catalog.nodes[0]?.attempts[0]).toMatchObject({ series_capped: true, truncated: false });
		const params = new URLSearchParams({
			chain_instance_id: summaryOfTask?.chain_instance_id ?? "",
			node_id: "load",
			metrics: "tps",
		});
		const series = metricsApi.series.response.parse(
			await api.getJson(`/runs/${runId}/metrics/series?${params}`),
		);
		expect(series).toMatchObject({ series_capped: true, truncated: false });
	});

	it("只接受任务所在 Agent、同一次尝试上报的指标", async () => {
		const agent = await connect();
		const other = await connect("agent-b");
		const { runId, task } = await start(agent);
		other.metrics(task, [["tps", at(1), 1]]);
		agent.metrics({ taskId: task.taskId, attempt: task.attempt + 1 }, [["tps", at(2), 2]]);
		agent.metrics(task, [["tps", at(3), 3]]);
		await other.sync();
		await agent.succeed(task);

		expect((await metricsOf(runId)).tps).toMatchObject({ points: 1, last: 3 });
	});

	it("运行中的点约 10 秒写一次库，不必等任务结束", async () => {
		const agent = await connect();
		const { runId, task } = await start(agent);
		agent.metrics(task, [["tps", at(1), 10]]);
		await agent.sync();
		// 还没到 10 秒：再等几轮扫描也不会写库。
		await new Promise((r) => setTimeout(r, 100));
		expect((await summary(runId)).tasks).toEqual([]);

		clock().advance(10_000);
		await eventually(async () => {
			expect((await metricsOf(runId)).tps).toMatchObject({ points: 1, last: 10 });
		});

		agent.metrics(task, [["tps", at(2), 20]]);
		await agent.sync();
		clock().advance(10_000);
		await eventually(async () => {
			expect((await metricsOf(runId)).tps).toMatchObject({ points: 2, last: 20, avg: 15 });
		});
	});

	it("控制面重启后已写入的数据仍可查询，之后的点接着累计，重启前已收到的秒仍按重复处理", async () => {
		const agent = await connect();
		const { runId, task } = await start(agent);
		agent.metrics(task, [
			["tps", at(1), 10],
			["tps", at(2), 20],
		]);
		await agent.sync();
		clock().advance(10_000);
		await eventually(async () => {
			expect((await metricsOf(runId)).tps?.points).toBe(2);
		});

		await agent.disconnect();
		agents.splice(0);
		await cp.restart();
		expect((await metricsOf(runId)).tps).toMatchObject({ points: 2, last: 20 });

		const again = await connect();
		again.metrics(task, [
			["tps", at(2), 99],
			["tps", at(3), 30],
		]);
		await again.succeed(task);
		expect((await metricsOf(runId)).tps).toMatchObject({
			points: 3,
			min: 10,
			max: 30,
			avg: 20,
			last: 30,
			first_time: iso(1),
			last_time: iso(3),
		});
	});

	it("任务记录的点数只计已写库的点，与摘要一致（崩溃后不会偏大）", async () => {
		const agent = await connect();
		const { runId, task } = await start(agent);
		// tps 的 1 个点留在内存里；requests 攒满一段（120 个点）立即写库。
		agent.metrics(task, [
			["tps", at(0), 1],
			...Array.from({ length: 120 }, (_, i): [string, number, number] => ["requests", at(i), i]),
		]);
		await eventually(async () => {
			expect((await metricsOf(runId)).requests?.points).toBe(120);
		});
		expect(Object.keys(await metricsOf(runId))).toEqual(["requests"]);

		// 任务记录上的点数是这条验收标准（摘要、上限判断的依据）的可观察结果，直接查数据库。
		const client = new pg.Client({ connectionString: cp.database.url });
		await client.connect();
		try {
			const { rows } = await client.query("select metric_points from tasks where id = $1", [
				task.taskId,
			]);
			expect(rows).toEqual([{ metric_points: "120" }]);
		} finally {
			await client.end();
		}
	});

	it("Agent 上报的丢弃点数累加在任务的摘要里", async () => {
		const agent = await connect();
		const { runId, task } = await start(agent);
		agent.metrics(task, [["tps", at(5), 5]], 3);
		agent.metrics(task, [], 2);
		await agent.succeed(task);

		expect((await summary(runId)).tasks[0]).toMatchObject({ dropped_points: 5, truncated: false });
	});

	it("开发版本按任务所在 Agent 上报的元信息判断指标是否声明", async () => {
		const metadata = {
			name: "bench",
			version: "dev",
			requires_python: ">=3.10",
			nodes: [
				{
					name: "load",
					title: "load",
					entry: "bench:load",
					inputs: { type: "object", properties: {} },
					outputs: { type: "object", properties: {} },
					metrics: [{ name: "latency", unit: "ms", kind: "gauge" }],
				},
			],
		};
		const agent = await connect("agent-a", [
			{ name: "bench", source: "/src/bench", metadataJson: JSON.stringify(metadata) },
		]);
		const { runId, task } = await start(agent, { ...ORCHESTRATION, packages: { bench: "dev" } });
		agent.metrics(task, [
			["latency", at(1), 12],
			["tps", at(1), 10],
		]);
		await agent.succeed(task);

		expect(Object.keys(await metricsOf(runId))).toEqual(["latency"]);
	});

	it("原始数据按天分区、按段存储：攒满 120 个点关闭一段，关闭的段在行内压缩", async () => {
		const agent = await connect();
		const { task } = await start(agent);
		// 典型的指标：整数、在小范围内波动。
		const points = Array.from({ length: 130 }, (_, i): [string, number, number] => [
			"tps",
			at(i),
			1000 + (i % 7),
		]);
		agent.metrics(task, points.slice(0, 60));
		agent.metrics(task, points.slice(60));
		await agent.succeed(task);

		// 存储本身就是这条验收标准的可观察结果，所以这里直接查数据库。
		const client = new pg.Client({ connectionString: cp.database.url });
		await client.connect();
		try {
			const { rows } = await client.query(
				`select tableoid::regclass::text as partition, points, offsets[1:3] as offsets,
					start_at, end_at, pg_column_compression("values") as compression
				from metric_segments where task_id = $1 order by start_at`,
				[task.taskId],
			);
			expect(rows).toEqual([
				{
					partition: "metric_segments_20260101",
					points: 120,
					offsets: [0, 1, 2],
					start_at: new Date(at(0) * 1000),
					end_at: new Date(at(119) * 1000),
					compression: "pglz",
				},
				{
					partition: "metric_segments_20260101",
					points: 10,
					offsets: [0, 1, 2],
					start_at: new Date(at(120) * 1000),
					end_at: new Date(at(129) * 1000),
					compression: null,
				},
			]);
		} finally {
			await client.end();
		}
	});

	it("运行不存在时返回 404", async () => {
		const res = await cp.fetch("/runs/00000000-0000-4000-8000-000000000000/metrics/summary");
		expect(res.status).toBe(404);
	});
});

/** 0012 之后的迁移加在当前代码会读写的表上的列：表名、列名、类型。 */
const LATER_COLUMNS: [string, string, string][] = [
	["tasks", "metric_series_capped", "boolean DEFAULT false NOT NULL"],
	["agents", "clock_offset_ms", "bigint"],
	["agents", "clock_offset_measured_at", "timestamp with time zone"],
];

describe("迁移前的指标数据", () => {
	let cp: TestControlPlane;
	let oldMigrations: string;
	const agents: FakeAgent[] = [];

	/**
	 * 只含加标签之前（0000–0011）的迁移的目录，模拟旧版控制面。旧版控制面阶段跑的仍是当前代码，它会读写
	 * 之后的迁移加的列，所以在这里先补上（{@link LATER_COLUMNS}），升级前再删掉，由真正的迁移重新加上。
	 */
	const migrationsBeforeLabels = async () => {
		const dir = await mkdtemp(join(tmpdir(), "sfly-migrations-"));
		await copy(defaultMigrationsDir, dir, { recursive: true });
		const journalPath = join(dir, "meta", "_journal.json");
		const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
			entries: { idx: number; tag: string }[];
		};
		journal.entries = journal.entries.filter((e) => e.idx <= 11);
		await writeFile(journalPath, JSON.stringify(journal));
		const last = join(dir, `${journal.entries.at(-1)?.tag}.sql`);
		const added = LATER_COLUMNS.map(
			([table, column, type]) => `ALTER TABLE "${table}" ADD COLUMN "${column}" ${type};`,
		);
		await writeFile(
			last,
			`${await readFile(last, "utf8")}--> statement-breakpoint\n${added.join("\n")}`,
		);
		return dir;
	};
	const dropLaterColumns = async () => {
		const client = new pg.Client({ connectionString: cp.database.url });
		await client.connect();
		try {
			for (const [table, column] of LATER_COLUMNS) {
				await client.query(`alter table "${table}" drop column "${column}"`);
			}
		} finally {
			await client.end();
		}
	};

	beforeEach(async () => {
		oldMigrations = await migrationsBeforeLabels();
		cp = await startTestControlPlane({ migrationsDir: oldMigrations });
		await publishPackage(cp, "bench", "1.0.0", {
			load: { outputs: [], metrics: [{ name: "tps", unit: "req/s", kind: "gauge" }] },
		});
	});
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
		await rm(oldMigrations, { recursive: true, force: true });
	});

	it("升级控制面后作为不带标签的序列照常可查，之后的点接着累计", async () => {
		const api = new ApiClient(cp);
		const agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
		agents.push(agent);
		const runId = await api.triggerOk(await api.orchestrationWith(ORCHESTRATION));
		const task = await agent.nextAssign();

		// 旧版控制面写入的数据：一段第 1–3 秒的点、摘要和任务上的点数（旧表结构，直接写库）。
		const client = new pg.Client({ connectionString: cp.database.url });
		await client.connect();
		try {
			await client.query(
				`create table if not exists metric_segments_20260101 partition of metric_segments
					for values from ('2026-01-01T00:00:00Z') to ('2026-01-02T00:00:00Z')
					with (toast_tuple_target = 128)`,
			);
			await client.query(
				`insert into metric_segments (run_id, task_id, metric, start_at, end_at, offsets, "values", mins, maxs,
					points, min, max, avg, last, ext)
				values ($1, $2, 'tps', $3, $4, '{0,1,2}', '{10,20,30}', '{10,20,30}', '{10,20,30}', 3, 10, 30, 20, 30, null)`,
				[runId, task.taskId, iso(1), iso(3)],
			);
			await client.query(
				`insert into metric_series (task_id, run_id, metric, points, min, max, sum, last, first_at, last_at)
				values ($1, $2, 'tps', 3, 10, 30, 60, 30, $3, $4)`,
				[task.taskId, runId, iso(1), iso(3)],
			);
			await client.query("update tasks set metric_points = 3 where id = $1", [task.taskId]);
		} finally {
			await client.end();
		}

		await agent.disconnect();
		agents.splice(0);
		await cp.restart(dropLaterColumns, { migrationsDir: defaultMigrationsDir });
		const again = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
		agents.push(again);
		again.metrics(task, [
			["tps", at(3), 99],
			["tps", at(4), 40],
		]);
		await again.succeed(task);

		const res = await cp.fetch(`/runs/${runId}/metrics/summary`);
		const body = metricsApi.summary.response.parse(await res.json());
		expect(body.tasks[0]?.metrics).toEqual([
			{
				name: "tps",
				labels: {},
				points: 4,
				min: 10,
				max: 40,
				avg: 25,
				last: 40,
				first_time: iso(1),
				last_time: iso(4),
			},
		]);
		const chain = (await api.run(runId)).chains[0]?.id as string;
		const params = new URLSearchParams({ chain_instance_id: chain, node_id: "load" });
		const series = metricsApi.series.response.parse(
			await (await cp.fetch(`/runs/${runId}/metrics/series?${params}`)).json(),
		);
		expect(series.series.map((s) => [s.name, s.labels, s.buckets.map((b) => b.last)])).toEqual([
			["tps", {}, [10, 20, 30, 40]],
		]);
	});
});

describe("指标单任务上限", () => {
	let cp: TestControlPlane;
	let agent: FakeAgent;

	beforeEach(async () => {
		// 每点按 28 字节折算：上限 3 个点。
		cp = await startTestControlPlane({ metricLimitBytes: 3 * 28 });
		await publishPackage(cp, "bench", "1.0.0", {
			load: { outputs: [], metrics: [{ name: "tps", unit: "req/s", kind: "gauge" }] },
		});
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
	});
	afterEach(async () => {
		await agent.disconnect();
		await cp.close();
	});

	it("超出上限后停止写入并记录截断标记，重启后依然截断", async () => {
		const api = new ApiClient(cp);
		const runId = await api.triggerOk(await api.orchestrationWith(ORCHESTRATION));
		const task = await agent.nextAssign();
		agent.metrics(task, [
			["tps", at(1), 1],
			["tps", at(2), 2],
		]);
		agent.metrics(task, [
			["tps", at(3), 3],
			["tps", at(4), 4],
			["tps", at(5), 5],
		]);
		await agent.sync();
		await agent.disconnect();
		await cp.restart();
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
		agent.metrics(task, [["tps", at(6), 6]]);
		await agent.succeed(task);

		const res = await cp.fetch(`/runs/${runId}/metrics/summary`);
		const body = metricsApi.summary.response.parse(await res.json());
		expect(body.tasks[0]).toMatchObject({ truncated: true, series_capped: false });
		expect(body.tasks[0]?.metrics).toEqual([
			expect.objectContaining({ name: "tps", points: 3, last: 3, last_time: iso(3) }),
		]);
	});
});
