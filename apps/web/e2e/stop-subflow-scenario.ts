import type { AssignedTask } from "../../server/test/support/fake-agent.js";
import type { ManualClock } from "../../server/test/support/manual-clock.js";
import type { TestControlPlane } from "../../server/test/support/test-control-plane.js";
import type { E2eFixtures } from "./fixtures";
import { createScenario, publishPackage, triggerRun } from "./support";

// 停止子流程节点（#85，SEMANTICS §4.1）的端到端测试与视觉回归共用的场景。

const ping = (id: string, extra: Record<string, unknown> = {}) => ({
	id,
	kind: "package",
	package: "demo-checks",
	node: "ping",
	inputs: { host: id },
	...extra,
});

/**
 * 压测期间监控：主链 entry → spawn（触发子流程「监控」）→ load → stop（停止「监控」）→ cleanup；
 * 子流程 mon → watch → flush（always）。
 */
export const STOP_SCENARIO = {
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry", params: [] },
		{ id: "spawn", kind: "async", params: {} },
		ping("load"),
		{ id: "stop", kind: "stop_subflow", subflow: "mon" },
		ping("cleanup"),
		{ id: "mon", kind: "subflow_entry", name: "监控", params: [] },
		ping("watch"),
		ping("flush", { always: true }),
	],
	edges: [
		{ from: "entry", to: "spawn", kind: "chain" },
		{ from: "spawn", to: "load", kind: "chain" },
		{ from: "load", to: "stop", kind: "chain" },
		{ from: "stop", to: "cleanup", kind: "chain" },
		{ from: "spawn", to: "mon", kind: "dispatch" },
		{ from: "mon", to: "watch", kind: "chain" },
		{ from: "watch", to: "flush", kind: "chain" },
	],
	packages: { "demo-checks": "1.2.0" },
};

/**
 * 运行到停止子流程节点开始等待（手动时钟，从触发开始计时）：load 与 watch 同时执行，load 3 秒后成功，
 * 停止子流程节点通知 Agent 终止 watch，自己进入等待。返回 finish：Agent 终止 watch（1 秒后），
 * flush 执行 2 秒、cleanup 执行 1 秒，运行成功。
 */
export async function stoppingRun(
	controlPlane: TestControlPlane,
	connectAgent: E2eFixtures["connectAgent"],
	clock: ManualClock,
) {
	const agent = await connectAgent({
		name: "agent-a",
		slots: 4,
		installedPackages: [{ name: "demo-checks", version: "1.2.0" }],
	});
	await publishPackage(controlPlane);
	const scenarioId = await createScenario(controlPlane, "压测期间监控", STOP_SCENARIO);
	const runId = await triggerRun(controlPlane, scenarioId);
	const tasks: Record<string, AssignedTask> = {};
	for (let i = 0; i < 2; i++) {
		const task = await agent.nextAssign();
		tasks[task.nodeId] = task;
	}
	clock.advance(3000);
	await agent.succeed(tasks.load as AssignedTask);
	await agent.nextCancel();
	clock.advance(1000);

	const finish = async () => {
		await agent.cancelled(tasks.watch as AssignedTask);
		const flush = await agent.nextAssign();
		clock.advance(2000);
		await agent.succeed(flush);
		const cleanup = await agent.nextAssign();
		clock.advance(1000);
		await agent.succeed(cleanup);
	};
	return { runId, scenarioId, finish };
}
