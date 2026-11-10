// 全栈（#31）：真实的控制面、Rust Agent 和 SDK 执行器。桩节点 metrics 声明并用 ctx.metric 上报指标，
// 经 Agent 合并转发后，能从运行的指标目录和序列查询端到端查到；带标签的指标（#78）按序列查到，SSE 推送也带标签。
// Agent 时间拨快 613 天（#174，ADR 0018）时指标照常查到，按控制面时间存储并带着 Agent 时间。
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
		// 点的控制面时间由真实 Agent 的单调时钟读数折算，是真实流逝的时间：控制面也用系统时钟。
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

describe("全栈：Agent 时间比控制面快 613 天时的指标", () => {
	const FAST_MS = 613 * 86_400_000;
	let cp: TestControlPlane;
	let venv: Awaited<ReturnType<typeof createStubVenv>>;
	let agent: RealAgent;
	let offsetDir: string;

	beforeAll(async () => {
		const bin = agentBinary();
		[cp, venv, offsetDir] = await Promise.all([
			startTestControlPlane({ clock: systemClock }),
			createStubVenv(),
			mkdtemp(join(tmpdir(), "sfly-agent-time-")),
		]);
		await publishStubPackage(cp);
		// 只供测试使用的隐藏选项：Agent 每次读 Agent 时间都加上文件里的偏移量，相当于把系统时间拨快 613 天。
		const offsetFile = join(offsetDir, "offset-ms");
		await writeFile(offsetFile, String(FAST_MS));
		agent = await startRealAgent({
			grpcUrl: cp.grpcUrl,
			name: "fast-agent",
			venv: venv.path,
			bin,
			env: { SFLY_AGENT_TIME_OFFSET_FILE: offsetFile },
		});
	}, 600_000);

	afterAll(async () => {
		await agent?.close();
		await cp?.close();
		await venv?.remove();
		if (offsetDir) await rm(offsetDir, { recursive: true, force: true });
	});

	it("指标没有被丢弃：能从目录和序列查询中查到，时间是控制面时间，并带着快 613 天的 Agent 时间", async () => {
		const api = new ApiClient(cp);
		const id = await api.orchestrationWith({
			default_agent: "fast-agent",
			nodes: [
				{ id: "entry", kind: "entry" },
				{
					id: "measure",
					kind: "package",
					package: "sfly-stub",
					node: "metrics",
					inputs: { steps: ["align", ["level", 5], ["level", 3], 1, ["level", 7]] },
				},
			],
			edges: [{ from: "entry", to: "measure", kind: "chain" }],
			packages: { "sfly-stub": "0.1.0" },
		});
		const before = Date.now();
		const runId = await api.triggerOk(id);
		await eventually(async () => expect((await api.run(runId)).status).toBe("success"), 30_000);
		const after = Date.now();
		/** 这次运行期间的控制面时间（点按秒取整，折算有一次网络延迟的误差：前后各放宽 2 秒）。 */
		const duringRun = (iso: string | null) => {
			const t = Date.parse(iso ?? "");
			return t >= before - 2000 && t <= after + 2000;
		};
		/** Agent 时间比控制面时间快 613 天（两者各自按秒取整，再加折算误差：放宽 3 秒）。 */
		const fastBy613Days = (time: string | null, agentTime: string) =>
			Math.abs(Date.parse(agentTime) - Date.parse(time ?? "") - FAST_MS) <= 3000;

		const catalog = metricsApi.catalog.response.parse(await api.getJson(`/runs/${runId}/metrics`));
		const [node] = catalog.nodes;
		const level = node?.attempts[0]?.metrics.find((m) => m.name === "level");
		expect(level).toMatchObject({ points: 2, min: 3, max: 7, last: 7 });
		if (!level) throw new Error("目录里没有 level");
		expect(duringRun(level.first_time), level.first_time ?? "").toBe(true);
		expect(duringRun(level.last_time), level.last_time ?? "").toBe(true);
		expect(fastBy613Days(level.first_time, level.first_agent_time)).toBe(true);
		expect(fastBy613Days(level.last_time, level.last_agent_time)).toBe(true);

		const params = new URLSearchParams({
			chain_instance_id: node?.chain_instance_id ?? "",
			node_id: "measure",
			metrics: "level",
		});
		const series = metricsApi.series.response.parse(
			await api.getJson(`/runs/${runId}/metrics/series?${params}`),
		);
		const buckets = series.series[0]?.buckets ?? [];
		expect(buckets.map((b) => [b.min, b.max, b.last])).toEqual([
			[3, 5, 3],
			[7, 7, 7],
		]);
		for (const b of buckets) {
			expect(duringRun(b.time), b.time ?? "").toBe(true);
			expect(fastBy613Days(b.time, b.agent_time), `${b.time} / ${b.agent_time}`).toBe(true);
		}
		// 相邻两秒的点在控制面时间上也相邻。
		expect(Date.parse(buckets[1]?.time ?? "") - Date.parse(buckets[0]?.time ?? "")).toBe(1000);
	}, 60_000);
});
