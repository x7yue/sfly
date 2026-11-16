import type { AssignedTask, FakeAgent } from "../../server/test/support/fake-agent.js";
import type { ManualClock } from "../../server/test/support/manual-clock.js";
import type { TestControlPlane } from "../../server/test/support/test-control-plane.js";
import type { E2eFixtures } from "./fixtures";
import { httpCheckPoints, logLine, metricPackage, pingPoints } from "./monitor-scenario";
import { createScenario, publishPackage } from "./support";

// 运行相关页面写显示名称（run-display-name.spec.ts）与视觉回归共用的场景。

export const NOTE = "从订单库拉取当天的订单，超时设为 600 秒：大促日数据量大。";

/** 主链 entry → fetch → spawn（派发子流程 sub → probe）→ verify（重试 1 次）；fetch 有备注。 */
export function namedDocument(names: {
	fetch: string;
	verify: string;
	subflow: string;
	probe?: string;
}) {
	const ping = (id: string, extra: Record<string, unknown>) => ({
		id,
		kind: "package",
		package: "demo-checks",
		node: "ping",
		inputs: { host: id },
		...extra,
	});
	return {
		default_agent: "agent-a",
		nodes: [
			{ id: "entry", kind: "entry", params: [] },
			{
				id: "fetch",
				kind: "package",
				package: "demo-checks",
				node: "http_check",
				inputs: { url: "https://example.test/orders" },
				display_name: names.fetch,
				note: NOTE,
			},
			{ id: "spawn", kind: "async", params: {}, display_name: "派发监控" },
			ping("verify", { retries: 1, display_name: names.verify }),
			{ id: "sub", kind: "subflow_entry", name: names.subflow, params: [] },
			ping("probe", { display_name: names.probe ?? "探测延迟" }),
		],
		edges: [
			{ from: "entry", to: "fetch", kind: "chain" },
			{ from: "fetch", to: "spawn", kind: "chain" },
			{ from: "spawn", to: "verify", kind: "chain" },
			{ from: "sub", to: "probe", kind: "chain" },
			{ from: "spawn", to: "sub", kind: "dispatch" },
		],
		packages: { "demo-checks": "1.2.0" },
	};
}

export const FIRST = { fetch: "拉取订单", verify: "核对结果", subflow: "压测监控" };
export const RENAMED = { fetch: "拉取全部订单", verify: "复核结果", subflow: "延迟监控" };

export async function namedScenario(
	controlPlane: TestControlPlane,
	connectAgent: E2eFixtures["connectAgent"],
	names: Parameters<typeof namedDocument>[0] = FIRST,
) {
	const agent = await connectAgent({
		name: "agent-a",
		slots: 4,
		installedPackages: [{ name: "demo-checks", version: "1.2.0" }],
	});
	await publishPackage(controlPlane, metricPackage());
	const scenarioId = await createScenario(controlPlane, "日终对账", namedDocument(names));
	return { agent, scenarioId };
}

/**
 * 运行到这个状态：fetch 输出日志、上报指标后成功；子流程的 probe 输出日志后失败；
 * verify 第 1 次失败，第 2 次执行中（上报了指标）。
 */
export async function driveToRetry(agent: FakeAgent, clock: ManualClock, fetch: AssignedTask) {
	const clock0 = clock.now().getTime();
	agent.logs(fetch, [logLine(clock, 1, "拉取 1200 笔订单")]);
	agent.metrics(fetch, httpCheckPoints(clock0, 0, 3));
	clock.advance(4000);
	await agent.succeed(fetch, { status: 200 });
	const assigned: Record<string, AssignedTask> = {};
	for (let i = 0; i < 2; i++) {
		const task = await agent.nextAssign();
		assigned[task.nodeId] = task;
	}
	const probe = assigned.probe as AssignedTask;
	agent.logs(probe, [logLine(clock, 1, "延迟 830ms")]);
	agent.metrics(probe, pingPoints(clock0, 4, 6));
	clock.advance(2000);
	await agent.fail(probe, "TimeoutError: 延迟超过阈值");
	await agent.fail(assigned.verify as AssignedTask, "AssertionError: 差 3 笔");
	const verify = await agent.nextAssign();
	agent.metrics(verify, pingPoints(clock0, 6, 8));
	await agent.sync();
	// 之后 verify 再失败时，主链晚于子流程失败（最近失败按失败时间排序）。
	clock.advance(1000);
	return verify;
}
