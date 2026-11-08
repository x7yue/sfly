// 全栈（#31）：真实的控制面、Rust Agent 和 SDK 执行器。桩节点 metrics 声明并用 ctx.metric 上报指标，
// 经 Agent 合并转发后，能从运行的指标目录和序列查询端到端查到；带标签的指标（#78）按序列查到，SSE 推送也带标签。
import { type MetricIncrement, metricsApi } from "@sfly/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemClock } from "../src/clock.js";
import { agentBinary } from "./support/agent-binary.js";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { createStubVenv, type RealAgent, startRealAgent } from "./support/real-agent.js";
import { SseClient } from "./support/sse-client.js";
import { publishStubPackage } from "./support/stub-package.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

describe("全栈：指标", () => {
	let cp: TestControlPlane;
	let venv: Awaited<ReturnType<typeof createStubVenv>>;
	let agent: RealAgent;

	beforeAll(async () => {
		const bin = agentBinary();
		// 点的时间戳来自真实 Agent 的系统时钟，控制面也用系统时钟：否则会超出保留期的可接收范围（#32）而被丢弃。
		[cp, venv] = await Promise.all([
			startTestControlPlane({ clock: systemClock }),
			createStubVenv(),
		]);
		await publishStubPackage(cp);
		agent = await startRealAgent({
			grpcUrl: cp.grpcUrl,
			name: "metrics-agent",
			venv: venv.path,
			bin,
		});
	}, 600_000);

	afterAll(async () => {
		await agent?.close();
		await cp?.close();
		await venv?.remove();
	});

	it("节点上报的指标能从目录和序列查询中查到", async () => {
		const api = new ApiClient(cp);
		const id = await api.orchestrationWith({
			default_agent: "metrics-agent",
			nodes: [
				{ id: "entry", kind: "entry" },
				{
					id: "measure",
					kind: "package",
					package: "sfly-stub",
					node: "metrics",
					inputs: {
						steps: [
							"align",
							["level", 5],
							["level", 3],
							["total", 1],
							1,
							["level", 7],
							["total", 4],
						],
					},
				},
			],
			edges: [{ from: "entry", to: "measure", kind: "chain" }],
			packages: { "sfly-stub": "0.1.0" },
		});
		const runId = await api.triggerOk(id);
		await eventually(async () => expect((await api.run(runId)).status).toBe("success"), 30_000);

		const catalog = metricsApi.catalog.response.parse(await api.getJson(`/runs/${runId}/metrics`));
		const [node] = catalog.nodes;
		expect(node).toMatchObject({
			node_id: "measure",
			package: "sfly-stub",
			node: "metrics",
			version: "0.1.0",
			primary_metric: "level",
			charts: [
				{ title: "level", type: "line", metrics: ["level"], default: true },
				{ title: "total", type: "stat", metrics: ["total"], default: true },
				{ title: "conn", type: "line", metrics: ["conn"], default: true },
			],
		});
		expect(node?.attempts[0]?.metrics.map((m) => [m.name, m.labels, m.points, m.last])).toEqual([
			["level", {}, 2, 7],
			["total", {}, 2, 4],
		]);

		const params = new URLSearchParams({
			chain_instance_id: node?.chain_instance_id ?? "",
			node_id: "measure",
		});
		const series = metricsApi.series.response.parse(
			await api.getJson(`/runs/${runId}/metrics/series?${params}`),
		);
		expect(
			Object.fromEntries(
				series.series.map((s) => [s.name, s.buckets.map((b) => [b.min, b.max, b.last])]),
			),
		).toEqual({
			// gauge：每秒最后一个值，附带这一秒的最小、最大值；counter：每秒期末值。
			// 带标签的 conn 没有上报过，没有序列。
			level: [
				[3, 5, 3],
				[7, 7, 7],
			],
			total: [
				[1, 1, 1],
				[4, 4, 4],
			],
		});
	}, 60_000);

	it("带标签的指标按序列查到：序列查询、摘要和 SSE 推送都带 labels", async () => {
		const api = new ApiClient(cp);
		const a = { host: "a", port: 80 };
		const b = { host: "b", port: 80 };
		const id = await api.orchestrationWith({
			default_agent: "metrics-agent",
			nodes: [
				{ id: "entry", kind: "entry" },
				{
					id: "measure",
					kind: "package",
					package: "sfly-stub",
					node: "metrics",
					inputs: {
						steps: [
							"align",
							["conn", 5, a],
							["conn", 1, b],
							["conn", 3, a],
							["level", 9],
							1,
							["conn", 7, a],
							["conn", 2, b],
							// 缺少声明过的键：SDK 丢弃并警告，不会到达控制面。
							["conn", 100, { host: "c" }],
						],
					},
				},
			],
			edges: [{ from: "entry", to: "measure", kind: "chain" }],
			packages: { "sfly-stub": "0.1.0" },
		});
		const runId = await api.triggerOk(id);
		const sse = await SseClient.open(cp, `/runs/${runId}/events`);
		const pushed: MetricIncrement["points"] = [];
		try {
			while (pushed.filter((p) => p.name === "conn").length < 4) {
				pushed.push(
					...(await sse.next<MetricIncrement>("metrics", { timeoutMs: 30_000 })).data.points,
				);
			}
		} finally {
			sse.close();
		}
		await eventually(async () => expect((await api.run(runId)).status).toBe("success"), 30_000);

		const hostA = { host: "a", port: "80" };
		const hostB = { host: "b", port: "80" };
		expect(
			pushed.filter((p) => p.name === "conn").map((p) => [p.labels, p.value, p.min, p.max]),
		).toEqual(
			expect.arrayContaining([
				[hostA, 3, 3, 5],
				[hostB, 1, 1, 1],
				[hostA, 7, 7, 7],
				[hostB, 2, 2, 2],
			]),
		);
		expect(pushed.find((p) => p.name === "level")?.labels).toEqual({});

		const catalog = metricsApi.catalog.response.parse(await api.getJson(`/runs/${runId}/metrics`));
		const [node] = catalog.nodes;
		expect(node?.metrics.find((m) => m.name === "conn")?.labels).toEqual(["host", "port"]);
		expect(node?.attempts[0]?.metrics.map((m) => [m.name, m.labels, m.points, m.last])).toEqual([
			["conn", hostA, 2, 7],
			["conn", hostB, 2, 2],
			["level", {}, 1, 9],
		]);

		const params = new URLSearchParams({
			chain_instance_id: node?.chain_instance_id ?? "",
			node_id: "measure",
			metrics: "conn",
		});
		const series = metricsApi.series.response.parse(
			await api.getJson(`/runs/${runId}/metrics/series?${params}`),
		);
		expect(series.series.map((s) => [s.name, s.labels, s.buckets.map((b) => b.last)])).toEqual([
			["conn", hostA, [3, 7]],
			["conn", hostB, [1, 2]],
		]);
	}, 60_000);
});
