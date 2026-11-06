// 切入点 A：指标上报与存储（#29）。假 Agent 经 gRPC 上报 MetricBatch，
// 通过运行的指标摘要接口 `GET /runs/:id/metrics/summary` 观察。
import { type MetricSummary, metricsApi, type RunMetricSummary } from "@sfly/schema";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
				],
			},
		});
	};

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
					dropped_points: 0,
					metrics: [
						{
							name: "requests",
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
		expect(body.tasks[0]).toMatchObject({ truncated: true });
		expect(body.tasks[0]?.metrics).toEqual([
			expect.objectContaining({ name: "tps", points: 3, last: 3, last_time: iso(3) }),
		]);
	});
});
