// 切入点 A：指标查询、降采样与实时推送（#31）。假 Agent 经 gRPC 上报 MetricBatch，
// 通过运行的指标目录、序列查询、平台自带图表接口和运行事件流（SSE）观察。
import type { RunMetricCatalog } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { type AssignedTask, FakeAgent, type HelloInit } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
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
	],
	charts: [{ title: "TPS", type: "area" as const, metrics: ["tps"] }],
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
		const agent = await FakeAgent.connect(cp.grpcUrl, { name, devPackages });
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
	const catalog = (runId: string) => api.getJson<RunMetricCatalog>(`/runs/${runId}/metrics`);
	/** 主链实例的 ID。 */
	const mainChain = async (runId: string) => (await api.run(runId)).chains[0]?.id as string;

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishPackage(cp, "bench", "1.0.0", { load: LOAD });
	});
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
	});

	describe("运行的指标目录", () => {
		it("列出每个节点的指标声明、含默认图表的图表定义、主指标，以及每次尝试的摘要和截断标记", async () => {
			const agent = await connect();
			const { runId, task } = await start(agent);
			agent.metrics(task, [
				["tps", at(1), 10],
				["tps", at(2), 30],
				["requests", at(2), 7],
			]);
			await agent.succeed(task);

			expect(await catalog(runId)).toEqual({
				run_id: runId,
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
							{ title: "p99", type: "line", metrics: ["p99"], default: true },
							{ title: "requests", type: "stat", metrics: ["requests"], default: true },
						],
						primary_metric: "tps",
						attempts: [
							{
								task_id: task.taskId,
								attempt: 1,
								truncated: false,
								dropped_points: 0,
								metrics: [
									{
										name: "requests",
										points: 1,
										min: 7,
										max: 7,
										avg: 7,
										last: 7,
										first_time: iso(2),
										last_time: iso(2),
									},
									{
										name: "tps",
										points: 2,
										min: 10,
										max: 30,
										avg: 20,
										last: 30,
										first_time: iso(1),
										last_time: iso(2),
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
