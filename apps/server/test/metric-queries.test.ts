// 切入点 A：指标查询、降采样与实时推送（#31）。假 Agent 经 gRPC 上报 MetricBatch，
// 通过运行的指标目录、序列查询、平台自带图表接口和运行事件流（SSE）观察。
import {
	bucketStartMs,
	type MetricIncrement,
	type MetricSeries,
	metricsApi,
	type PlatformBucket,
} from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { type AssignedTask, FakeAgent, type HelloInit } from "./support/fake-agent.js";
import type { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { SseClient } from "./support/sse-client.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

/** 2026-01-01T00:00:00Z（测试时钟的起点）之后第 s 秒（Unix 秒）。 */
const at = (s: number) => Date.UTC(2026, 0, 1) / 1000 + s;
const iso = (s: number) => new Date(at(s) * 1000).toISOString();

const LOAD = {
	outputs: [],
	metrics: [
		{ name: "tps", unit: "req/s", kind: "gauge" as const },
		{ name: "p99", unit: "ms", kind: "gauge" as const },
		{ name: "requests", unit: "", kind: "counter" as const },
		{ name: "conn_tps", unit: "req/s", kind: "gauge" as const, labels: ["host"] },
	],
	charts: [
		{ title: "TPS", type: "area" as const, metrics: ["tps"] },
		{ title: "各连接", type: "line" as const, metrics: ["tps", "conn_tps"] },
	],
	primary_metric: "tps",
};

const orchestration = (load: Record<string, unknown> = {}, version = "1.0.0") => ({
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry" },
		{ id: "load", kind: "package", package: "bench", node: "load", ...load },
	],
	edges: [{ from: "entry", to: "load", kind: "chain" }],
	packages: { bench: version },
});

describe("指标查询", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	const agents: FakeAgent[] = [];

	const connect = async (name = "agent-a", devPackages: HelloInit["devPackages"] = []) => {
		const agent = await FakeAgent.connect(cp.grpcUrl, { name, devPackages }, { clock: cp.clock });
		agents.push(agent);
		return agent;
	};
	const start = async (
		agent: FakeAgent,
		document: unknown = orchestration(),
	): Promise<{ runId: string; task: AssignedTask }> => {
		const runId = await api.triggerOk(await api.orchestrationWith(document));
		return { runId, task: await agent.nextAssign() };
	};
	const catalog = async (runId: string) =>
		metricsApi.catalog.response.parse(await api.getJson(`/runs/${runId}/metrics`));
	/** 主链实例的 ID。 */
	const mainChain = async (runId: string) => (await api.run(runId)).chains[0]?.id as string;
	/** 主链上 load 节点的序列查询；query 是其余的查询参数。 */
	const seriesRes = async (runId: string, query: Record<string, string | number> = {}) => {
		const params = new URLSearchParams({
			chain_instance_id: await mainChain(runId),
			node_id: "load",
			...Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])),
		});
		return cp.fetch(`/runs/${runId}/metrics/series?${params}`);
	};
	const series = async (runId: string, query: Record<string, string | number> = {}) => {
		const res = await seriesRes(runId, query);
		expect(res.status, await res.clone().text()).toBe(200);
		return metricsApi.series.response.parse(await res.json());
	};
	/** 平均值按 6 位小数比较（段摘要只存平均值，按点数加权时有浮点误差）。 */
	const round = (n: number) => Math.round(n * 1e6) / 1e6;
	/** 指标名 → 桶的 [相对秒, 点数, 最小, 最大, 平均, 最新]。 */
	const bucketsOf = (result: MetricSeries) =>
		Object.fromEntries(
			result.series.map((s) => [
				s.name,
				s.buckets.map((b) => [
					(bucketStartMs(b) - Date.UTC(2026, 0, 1)) / 1000,
					b.points,
					b.min,
					b.max,
					round(b.avg),
					b.last,
				]),
			]),
		);

	/** 序列（「指标名 主机」，不带标签时只有指标名）→ 桶的 [相对秒, 点数, 最小, 最大, 平均, 最新]。 */
	const seriesOf = (result: MetricSeries) =>
		Object.fromEntries(
			result.series.map((s) => [
				[s.name, ...Object.values(s.labels)].join(" "),
				bucketsOf({ ...result, series: [s] })[s.name],
			]),
		);

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishPackage(cp, "bench", "1.0.0", { load: LOAD });
	});
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
	});

	describe("序列查询", () => {
		it("按目标点数分桶，每个桶给出最小、最大、平均、最新值，尖峰在降采样后仍可见", async () => {
			const agent = await connect();
			const { runId, task } = await start(agent);
			agent.metrics(
				task,
				Array.from({ length: 60 }, (_, i) => {
					// 第 17 秒内有一次瞬时尖峰（每秒最大值），第 33 秒的值本身是尖峰。
					if (i === 17)
						return { name: "tps", timeUnixS: BigInt(at(i)), value: 10, min: 2, max: 500 };
					return ["tps", at(i), i === 33 ? 900 : 10] as [string, number, number];
				}),
			);
			agent.metrics(task, [["requests", at(59), 600]]);
			await agent.succeed(task);

			const result = await series(runId, { metrics: "tps,requests", points: 6 });
			expect(result).toMatchObject({
				run_id: runId,
				node_id: "load",
				task_id: task.taskId,
				attempt: 1,
				expired: false,
				from: iso(0),
				to: iso(59),
				bucket_seconds: 10,
				truncated: false,
			});
			expect(result.series.map((s) => s.name)).toEqual(["tps", "requests"]);
			expect(bucketsOf(result)).toEqual({
				tps: [
					[0, 10, 10, 10, 10, 10],
					[10, 10, 2, 500, 10, 10],
					[20, 10, 10, 10, 10, 10],
					[30, 10, 10, 900, 99, 10],
					[40, 10, 10, 10, 10, 10],
					[50, 10, 10, 10, 10, 10],
				],
				requests: [[50, 1, 600, 600, 600, 600]],
			});
		});

		it("只取时间范围内的点；不指定指标时返回节点类型声明的全部指标，没有数据的指标桶为空", async () => {
			const agent = await connect();
			const { runId, task } = await start(agent);
			agent.metrics(
				task,
				Array.from({ length: 30 }, (_, i): [string, number, number] => ["tps", at(i), i]),
			);
			await agent.succeed(task);

			const result = await series(runId, { from: iso(10), to: iso(13) });
			expect(result).toMatchObject({ from: iso(10), to: iso(13), bucket_seconds: 1 });
			expect(bucketsOf(result)).toEqual({
				tps: [
					[10, 1, 10, 10, 10, 10],
					[11, 1, 11, 11, 11, 11],
					[12, 1, 12, 12, 12, 12],
					[13, 1, 13, 13, 13, 13],
				],
				p99: [],
				requests: [],
			});
		});

		it("跨越多段的数据：桶包含整段时与展开数组的结果一致", async () => {
			const agent = await connect();
			const { runId, task } = await start(agent);
			// 一段攒满 120 个点关闭：第 0–119 秒一段、第 120–129 秒一段。
			const values = Array.from({ length: 130 }, (_, i) => (i % 10) * 10);
			values[70] = 5000;
			agent.metrics(
				task,
				values.map((v, i): [string, number, number] => ["tps", at(i), v]),
			);
			await agent.succeed(task);

			// 一个桶包含两段。
			expect(bucketsOf(await series(runId, { metrics: "tps", points: 1 }))).toEqual({
				tps: [[0, 130, 0, 5000, round(10850 / 130), 90]],
			});
			// 桶边界在第一段中间：第一段需要展开。
			expect(bucketsOf(await series(runId, { metrics: "tps", points: 2 }))).toEqual({
				tps: [
					[0, 65, 0, 90, round(2800 / 65), 40],
					[65, 65, 0, 5000, round(8050 / 65), 90],
				],
			});
			// 桶跨度不小于段跨度（240 秒一桶，从第 0 秒开始）：两段都直接用段摘要。
			expect(
				bucketsOf(await series(runId, { metrics: "tps", from: iso(0), to: iso(479), points: 2 })),
			).toEqual({
				tps: [[0, 130, 0, 5000, round(10850 / 130), 90]],
			});
		});

		it("按序列（指标名 + 标签）分别降采样，按指标名查询时返回这个指标的全部序列", async () => {
			const agent = await connect();
			const { runId, task } = await start(agent);
			const conn = (host: string, t: number, value: number) => ({
				name: "conn_tps",
				labels: { host },
				timeUnixS: BigInt(at(t)),
				value,
				min: value,
				max: value,
			});
			// host=a 第 0–129 秒：前 120 个点攒满一段写库，后 10 个点还在内存里；host=b 只有内存里的 4 个点。
			agent.metrics(task, [
				...Array.from({ length: 130 }, (_, i) => conn("a", i, i < 120 ? 1 : 2)),
				...Array.from({ length: 4 }, (_, i) => conn("b", 120 + i, 100 + i)),
				["tps", at(125), 7],
			]);
			await agent.sync();

			const expected = {
				"conn_tps a": [
					[0, 65, 1, 1, 1, 1],
					[65, 65, 1, 2, round((55 + 20) / 65), 2],
				],
				"conn_tps b": [[65, 4, 100, 103, 101.5, 103]],
			};
			const running = await series(runId, { metrics: "conn_tps", points: 2 });
			expect(running.series.map((s) => [s.name, s.labels])).toEqual([
				["conn_tps", { host: "a" }],
				["conn_tps", { host: "b" }],
			]);
			expect(seriesOf(running)).toEqual(expected);

			await agent.succeed(task);
			const done = await series(runId, { metrics: "tps,conn_tps", points: 2 });
			expect(done.series.map((s) => [s.name, s.labels])).toEqual([
				["tps", {}],
				["conn_tps", { host: "a" }],
				["conn_tps", { host: "b" }],
			]);
			expect(seriesOf(done)).toEqual({ tps: [[65, 1, 7, 7, 7, 7]], ...expected });
		});

		it("运行中尚未写库的点也能查到（断线重连后用来补齐实时增量）", async () => {
			const agent = await connect();
			const { runId, task } = await start(agent);
			agent.metrics(task, [
				["tps", at(1), 10],
				["tps", at(2), 20],
			]);
			await agent.sync();
			expect(bucketsOf(await series(runId, { metrics: "tps" }))).toEqual({
				tps: [
					[1, 1, 10, 10, 10, 10],
					[2, 1, 20, 20, 20, 20],
				],
			});
			expect((await catalog(runId)).nodes[0]?.attempts[0]?.metrics).toEqual([]);
		});

		it("多次尝试分别可查，默认最新一次", async () => {
			const agent = await connect();
			const { runId, task } = await start(agent, orchestration({ retries: 1 }));
			agent.metrics(task, [["tps", at(1), 1]]);
			await agent.fail(task);
			const retry = await agent.nextAssign();
			agent.metrics(retry, [["tps", at(5), 5]]);
			await agent.succeed(retry);

			const latest = await series(runId, { metrics: "tps" });
			expect(latest).toMatchObject({ task_id: retry.taskId, attempt: 2 });
			expect(bucketsOf(latest)).toEqual({ tps: [[5, 1, 5, 5, 5, 5]] });
			const first = await series(runId, { metrics: "tps", attempt: 1 });
			expect(first).toMatchObject({ task_id: task.taskId, attempt: 1 });
			expect(bucketsOf(first)).toEqual({ tps: [[1, 1, 1, 1, 1, 1]] });
			expect((await seriesRes(runId, { attempt: 3 })).status).toBe(404);
		});

		it("没有任何数据时时间范围为空；参数不合法返回 400，节点不存在返回 404", async () => {
			const agent = await connect();
			const { runId } = await start(agent);
			expect(await series(runId, { metrics: "tps" })).toMatchObject({
				from: null,
				to: null,
				series: [{ name: "tps", labels: {}, buckets: [] }],
			});
			const invalid: Record<string, string | number>[] = [
				{ metrics: "not-a-name" },
				{ points: 0 },
				{ from: "yesterday" },
				{ from: iso(10), to: iso(9) },
			];
			for (const query of invalid) {
				expect((await seriesRes(runId, query)).status, JSON.stringify(query)).toBe(400);
			}
			const missing = new URLSearchParams({
				chain_instance_id: await mainChain(runId),
				node_id: "nope",
			});
			expect((await cp.fetch(`/runs/${runId}/metrics/series?${missing}`)).status).toBe(404);
		});
	});

	describe("实时增量", () => {
		it("运行事件流推送执行中任务新收到的点；重复、未声明和非有限的点不推送", async () => {
			const agent = await connect();
			const { runId, task } = await start(agent);
			const sse = await SseClient.open(cp, `/runs/${runId}/events`);
			try {
				await sse.next("run");
				agent.metrics(task, [
					{ name: "tps", timeUnixS: BigInt(at(1)), value: 10, min: 4, max: 12 },
					["typo", at(1), 1],
					["requests", at(1), 3],
					{
						name: "conn_tps",
						labels: { host: "a" },
						timeUnixS: BigInt(at(1)),
						value: 5,
						min: 5,
						max: 5,
					},
					{
						name: "conn_tps",
						labels: { host: "b" },
						timeUnixS: BigInt(at(1)),
						value: 6,
						min: 6,
						max: 6,
					},
				]);
				const first = await sse.next<MetricIncrement>("metrics");
				expect(first.data).toEqual({
					task_id: task.taskId,
					chain_instance_id: await mainChain(runId),
					node_id: "load",
					attempt: 1,
					points: [
						{ name: "tps", labels: {}, time: iso(1), agent_time: iso(1), value: 10, min: 4, max: 12 },
						{ name: "requests", labels: {}, time: iso(1), agent_time: iso(1), value: 3, min: 3, max: 3 },
						{ name: "conn_tps", labels: { host: "a" }, time: iso(1), agent_time: iso(1), value: 5, min: 5, max: 5 },
						{ name: "conn_tps", labels: { host: "b" }, time: iso(1), agent_time: iso(1), value: 6, min: 6, max: 6 },
					],
				});

				agent.metrics(task, [
					["tps", at(1), 99],
					["tps", at(2), Number.NaN],
					["tps", at(3), 30],
				]);
				expect((await sse.next<MetricIncrement>("metrics")).data.points).toEqual([
					{ name: "tps", labels: {}, time: iso(3), agent_time: iso(3), value: 30, min: 30, max: 30 },
				]);

				// 一批里没有新点时不推送。
				agent.metrics(task, [["tps", at(3), 30]]);
				await agent.sync();
				await sse.expectNone(100);
			} finally {
				sse.close();
			}
		});
	});

	describe("平台自带图表", () => {
		/** 桶的 [相对秒, 最大, 平均]。 */
		const occupancy = (buckets: PlatformBucket[]) =>
			buckets.map((b) => [(Date.parse(b.time) - Date.UTC(2026, 0, 1)) / 1000, b.max, b.avg]);

		it("节点耗时、重试次数、排队与等待时长由任务记录计算，并发任务数与 Agent 槽位占用由执行区间推导", async () => {
			const clock = cp.clock as ManualClock;
			const agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 4 }, { clock: cp.clock });
			agents.push(agent);
			const document = orchestration({ retries: 1 });
			document.nodes.push({ id: "pause", kind: "sleep", duration: "10s" } as never);
			document.edges.push({ from: "load", to: "pause", kind: "chain" });
			const runId = await api.triggerOk(await api.orchestrationWith(document));
			const other = await api.orchestrationWith(orchestration());

			// 第 0 秒排队，第 2 秒开始执行，第 5 秒失败；重试第 5 秒排队，第 6 秒开始执行，第 10 秒成功；
			// 之后 Sleep 节点等待 10 秒。另一个运行的任务在同一个 Agent 上从第 7 秒执行到第 12 秒。
			const first = await agent.nextAssign({ start: false });
			clock.advance(2000);
			await agent.started(first);
			clock.advance(3000);
			await agent.fail(first);
			const retry = await agent.nextAssign({ start: false });
			clock.advance(1000);
			await agent.started(retry);
			clock.advance(1000);
			await api.triggerOk(other);
			const parallel = await agent.nextAssign();
			clock.advance(3000);
			await agent.succeed(retry);
			clock.advance(2000);
			await agent.succeed(parallel);
			clock.advance(8000);
			await eventually(async () => expect((await api.run(runId)).status).toBe("success"));

			const platform = metricsApi.platform.response.parse(
				await api.getJson(`/runs/${runId}/metrics/platform?points=10`),
			);
			expect(platform).toMatchObject({
				run_id: runId,
				from: iso(0),
				to: iso(20),
				bucket_seconds: 2,
				retries: 1,
			});
			const chain = await mainChain(runId);
			expect(platform.nodes).toEqual([
				{
					chain_instance_id: chain,
					node_id: "entry",
					kind: "entry",
					attempts: 1,
					retries: 0,
					duration_ms: 0,
					queue_ms: 0,
					wait_ms: 0,
				},
				{
					chain_instance_id: chain,
					node_id: "load",
					kind: "package",
					attempts: 2,
					retries: 1,
					duration_ms: 10_000,
					queue_ms: 3000,
					wait_ms: 0,
				},
				{
					chain_instance_id: chain,
					node_id: "pause",
					kind: "sleep",
					attempts: 1,
					retries: 0,
					duration_ms: 10_000,
					queue_ms: 0,
					wait_ms: 10_000,
				},
			]);
			expect(occupancy(platform.concurrency)).toEqual([
				[0, 0, 0],
				[2, 1, 1],
				[4, 1, 0.5],
				[6, 1, 1],
				[8, 1, 1],
				[10, 0, 0],
				[12, 0, 0],
				[14, 0, 0],
				[16, 0, 0],
				[18, 0, 0],
			]);
			expect(platform.agents.map((a) => [a.name, a.slots, occupancy(a.occupancy)])).toEqual([
				[
					"agent-a",
					4,
					[
						[0, 0, 0],
						[2, 1, 1],
						[4, 1, 0.5],
						[6, 2, 1.5],
						[8, 2, 2],
						[10, 1, 1],
						[12, 0, 0],
						[14, 0, 0],
						[16, 0, 0],
						[18, 0, 0],
					],
				],
			]);
		});

		it("运行不存在时返回 404", async () => {
			const res = await cp.fetch("/runs/00000000-0000-4000-8000-000000000000/metrics/platform");
			expect(res.status).toBe(404);
		});
	});

	describe("运行的指标目录", () => {
		it("列出每个节点的指标声明、含默认图表的图表定义、主指标，以及每次尝试的摘要和截断标记", async () => {
			const agent = await connect();
			const { runId, task } = await start(agent);
			agent.metrics(task, [
				["tps", at(1), 10],
				["tps", at(2), 30],
				["requests", at(2), 7],
				{
					name: "conn_tps",
					labels: { host: "a" },
					timeUnixS: BigInt(at(2)),
					value: 3,
					min: 3,
					max: 3,
				},
			]);
			await agent.succeed(task);

			expect(await catalog(runId)).toEqual({
				run_id: runId,
				expired: false,
				nodes: [
					{
						chain_instance_id: await mainChain(runId),
						node_id: "load",
						package: "bench",
						node: "load",
						version: "1.0.0",
						metrics: LOAD.metrics,
						charts: [
							{ title: "TPS", type: "area", metrics: ["tps"], default: false },
							{ title: "各连接", type: "line", metrics: ["tps", "conn_tps"], default: false },
							{ title: "p99", type: "line", metrics: ["p99"], default: true },
							{ title: "requests", type: "stat", metrics: ["requests"], default: true },
						],
						primary_metric: "tps",
						attempts: [
							{
								task_id: task.taskId,
								attempt: 1,
								truncated: false,
								series_capped: false,
								dropped_points: 0,
								metrics: [
									{
										name: "conn_tps",
										labels: { host: "a" },
										points: 1,
										min: 3,
										max: 3,
										avg: 3,
										last: 3,
										first_time: iso(2),
										last_time: iso(2),
										first_agent_time: iso(2),
										last_agent_time: iso(2),
									},
									{
										name: "requests",
										labels: {},
										points: 1,
										min: 7,
										max: 7,
										avg: 7,
										last: 7,
										first_time: iso(2),
										last_time: iso(2),
										first_agent_time: iso(2),
										last_agent_time: iso(2),
									},
									{
										name: "tps",
										labels: {},
										points: 2,
										min: 10,
										max: 30,
										avg: 20,
										last: 30,
										first_time: iso(1),
										last_time: iso(2),
										first_agent_time: iso(1),
										last_agent_time: iso(2),
									},
								],
							},
						],
					},
				],
			});
		});

		it("重试产生的每次尝试分别列出，按 attempt 升序", async () => {
			const agent = await connect();
			const { runId, task } = await start(agent, orchestration({ retries: 1 }));
			agent.metrics(task, [["tps", at(1), 1]]);
			await agent.fail(task);
			const retry = await agent.nextAssign();
			agent.metrics(retry, [
				["tps", at(5), 5],
				["tps", at(6), 6],
			]);
			await agent.succeed(retry);

			const [node] = (await catalog(runId)).nodes;
			expect(
				node?.attempts.map((a) => [a.task_id, a.attempt, a.metrics.map((m) => [m.name, m.points])]),
			).toEqual([
				[task.taskId, 1, [["tps", 1]]],
				[retry.taskId, 2, [["tps", 2]]],
			]);
		});

		it("开发版本的声明取任务所在 Agent 当前加载的源码", async () => {
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
			const { runId } = await start(agent, orchestration({}, "dev"));

			expect((await catalog(runId)).nodes).toEqual([
				expect.objectContaining({
					version: "dev",
					metrics: [{ name: "latency", unit: "ms", kind: "gauge" }],
					charts: [{ title: "latency", type: "line", metrics: ["latency"], default: true }],
					primary_metric: null,
				}),
			]);
		});

		it("运行不存在时返回 404", async () => {
			const res = await cp.fetch("/runs/00000000-0000-4000-8000-000000000000/metrics");
			expect(res.status).toBe(404);
		});
	});
});
