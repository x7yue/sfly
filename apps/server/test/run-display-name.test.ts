// 切入点 A：运行里的节点带上显示名称（#313）。运行视图、运行列表和控制台统计从运行绑定的场景版本里补上
// display_name（子流程入口节点是子流程名称），运行列表和控制台里的子流程链和失败带上子流程名称。
// HTTP API + 讲真实 gRPC 的假 Agent + 真实 PostgreSQL；响应按契约解析。
import { dashboardApi, runListApi, runsApi } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { type AssignedTask, FakeAgent } from "./support/fake-agent.js";
import type { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const echo = (id: string, extra: Record<string, unknown> = {}) => ({
	id,
	kind: "package",
	package: "stub",
	node: "echo",
	inputs: {},
	...extra,
});

/** 主链 entry → spawn → check，子流程 sub → probe。 */
const document = (names: { check: string; subflow: string }) => ({
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry" },
		{ id: "spawn", kind: "async", params: {}, display_name: " 派发监控 " },
		echo("check", { display_name: names.check }),
		{ id: "sub", kind: "subflow_entry", name: names.subflow },
		echo("probe"),
	],
	edges: [
		{ from: "entry", to: "spawn", kind: "chain" },
		{ from: "spawn", to: "check", kind: "chain" },
		{ from: "sub", to: "probe", kind: "chain" },
		{ from: "spawn", to: "sub", kind: "dispatch" },
	],
	packages: { stub: "1.0.0" },
});

describe("运行里的节点带上显示名称", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let agent: FakeAgent;

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 4 });
	});
	afterEach(async () => {
		await agent.disconnect();
		await cp.close();
	});

	const view = async (runId: string) =>
		runsApi.get.response.parse(await (await cp.fetch(`/runs/${runId}`)).json());
	const nameOf = async (runId: string, nodeId: string) =>
		(await view(runId)).chains[0]?.nodes.find((n) => n.node_id === nodeId)?.display_name;
	const list = async () =>
		runListApi.list.response.parse(await (await cp.fetch("/runs")).json()).runs;
	const dashboard = async () =>
		dashboardApi.get.response.parse(await (await cp.fetch("/dashboard")).json());

	/** 触发后 probe 失败（子流程失败），check 执行中。 */
	async function runUntilProbeFails(scenarioId: string) {
		const runId = await api.triggerOk(scenarioId);
		const tasks: Record<string, AssignedTask> = {};
		for (let i = 0; i < 2; i++) {
			const task = await agent.nextAssign();
			tasks[task.nodeId] = task;
		}
		await agent.fail(tasks.probe as AssignedTask);
		return { runId, check: tasks.check as AssignedTask };
	}

	it("运行视图、运行列表、控制台统计里的节点带上运行绑定版本里的显示名称；改名之后旧运行不变", async () => {
		const scenarioId = await api.orchestrationWith(
			document({ check: "核对结果", subflow: "压测监控" }),
			"日终对账",
		);
		const { runId, check } = await runUntilProbeFails(scenarioId);

		const names = (await view(runId)).chains.map((c) =>
			c.nodes.map((n) => [n.node_id, n.display_name]),
		);
		expect(names).toEqual([
			[
				["entry", undefined],
				["spawn", "派发监控"],
				["check", "核对结果"],
			],
			[
				["sub", "压测监控"],
				["probe", undefined],
			],
		]);

		const [listed] = await list();
		expect(listed?.active_nodes).toMatchObject([{ node_id: "check", display_name: "核对结果" }]);
		expect(listed?.failures).toEqual([
			{
				chain_instance_id: expect.any(String),
				chain_id: "sub",
				subflow: true,
				subflow_name: "压测监控",
				node_id: "probe",
			},
		]);
		expect(listed?.chains.map((c) => [c.chain_id, c.subflow_name])).toEqual([
			["entry", undefined],
			["sub", "压测监控"],
		]);

		const stats = await dashboard();
		expect(stats.running_runs[0]?.chains.map((c) => [c.chain_id, c.subflow_name])).toEqual([
			["entry", undefined],
			["sub", "压测监控"],
		]);
		expect(stats.running_runs[0]?.chains[0]?.nodes).toEqual([
			{ node_id: "entry", status: "success" },
			{ node_id: "spawn", display_name: "派发监控", status: "success" },
			{ node_id: "check", display_name: "核对结果", status: "running" },
		]);
		expect(stats.running_runs[0]?.active_nodes).toMatchObject([
			{ node_id: "check", display_name: "核对结果" },
		]);
		// 主链还在运行：运行没有结束，不在最近结束里。
		expect(stats.recent_ended).toEqual([]);

		// 主链晚于子流程失败：运行结束，最先失败的是子流程里的 probe（没有显示名称）。
		(cp.clock as ManualClock).advance(1000);
		await agent.fail(check);
		await api.saveVersion(scenarioId, document({ check: "复核结果", subflow: "延迟监控" }));
		const next = await runUntilProbeFails(scenarioId);

		expect(await nameOf(runId, "check")).toBe("核对结果");
		expect(await nameOf(next.runId, "check")).toBe("复核结果");
		const runs = await list();
		expect(runs.find((r) => r.id === runId)?.failures).toContainEqual(
			expect.objectContaining({ node_id: "check", display_name: "核对结果" }),
		);
		expect(runs.find((r) => r.id === next.runId)?.active_nodes).toMatchObject([
			{ node_id: "check", display_name: "复核结果" },
		]);
		expect(runs.find((r) => r.id === runId)?.chains[1]?.subflow_name).toBe("压测监控");
		expect(runs.find((r) => r.id === next.runId)?.chains[1]?.subflow_name).toBe("延迟监控");

		const afterNext = await dashboard();
		expect(afterNext.recent_ended).toMatchObject([
			{ id: runId, status: "failed", failure: { chain_id: "sub", subflow_name: "压测监控" } },
		]);
		const [ended] = afterNext.recent_ended;
		expect(ended?.status === "failed" && ended.failure).toMatchObject({ node_id: "probe" });
		expect(ended?.status === "failed" && ended.failure).not.toHaveProperty("display_name");
		const nextRunning = afterNext.running_runs.find((r) => r.id === next.runId);
		expect(nextRunning?.chains.map((c) => [c.chain_id, c.subflow_name])).toEqual([
			["entry", undefined],
			["sub", "延迟监控"],
		]);

		// 主链的 check 先失败、子流程的 probe 后失败：失败节点带上显示名称。
		const third = await api.triggerOk(scenarioId);
		const tasks: Record<string, AssignedTask> = {};
		for (let i = 0; i < 2; i++) {
			const task = await agent.nextAssign();
			tasks[task.nodeId] = task;
		}
		await agent.fail(tasks.check as AssignedTask);
		(cp.clock as ManualClock).advance(1000);
		await agent.fail(tasks.probe as AssignedTask);
		const thirdEnded = (await dashboard()).recent_ended.find((r) => r.id === third);
		expect(thirdEnded?.status === "failed" && thirdEnded.failure).toMatchObject({
			subflow: false,
			node_id: "check",
			display_name: "复核结果",
		});
	});
});
