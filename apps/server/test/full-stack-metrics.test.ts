// 全栈（#31）：真实的控制面、Rust Agent 和 SDK 执行器。桩节点 metrics 声明并用 ctx.metric 上报指标，
// 经 Agent 合并转发后，能从运行的指标目录和序列查询端到端查到。
import type { MetricSeries, RunMetricCatalog } from "@sfly/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentBinary } from "./support/agent-binary.js";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { createStubVenv, type RealAgent, startRealAgent } from "./support/real-agent.js";
import { publishStubPackage } from "./support/stub-package.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

describe("全栈：指标", () => {
	let cp: TestControlPlane;
	let venv: Awaited<ReturnType<typeof createStubVenv>>;
	let agent: RealAgent;

	beforeAll(async () => {
		const bin = agentBinary();
		[cp, venv] = await Promise.all([startTestControlPlane(), createStubVenv()]);
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

		const catalog = await api.getJson<RunMetricCatalog>(`/runs/${runId}/metrics`);
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
			],
		});
		expect(node?.attempts[0]?.metrics.map((m) => [m.name, m.points, m.last])).toEqual([
			["level", 2, 7],
			["total", 2, 4],
		]);

		const params = new URLSearchParams({
			chain_instance_id: node?.chain_instance_id ?? "",
			node_id: "measure",
		});
		const series = await api.getJson<MetricSeries>(`/runs/${runId}/metrics/series?${params}`);
		expect(
			Object.fromEntries(
				series.series.map((s) => [s.name, s.buckets.map((b) => [b.min, b.max, b.last])]),
			),
		).toEqual({
			// gauge：每秒最后一个值，附带这一秒的最小、最大值；counter：每秒期末值。
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
});
