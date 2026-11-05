import type { FakeAgent } from "../../server/test/support/fake-agent.js";
import type { ManualClock } from "../../server/test/support/manual-clock.js";
import type { TestControlPlane } from "../../server/test/support/test-control-plane.js";
import { createScenario, publishPackage, triggerRun } from "./support";

/** 运行记录页（runs.spec.ts 与视觉回归）共用的数据准备。 */

const ping = (id: string) => ({
	id,
	kind: "package",
	package: "demo-checks",
	node: "ping",
	inputs: { host: "h" },
});

/** 主链 entry → check → verify；带 subflow 时主链在 check 之后派发子流程 sub（sub → probe）。 */
export function runDocument(options: { subflow?: boolean } = {}) {
	const main = [
		{ id: "entry", kind: "entry" },
		ping("check"),
		...(options.subflow ? [{ id: "spawn", kind: "async", params: {} }] : []),
		ping("verify"),
	];
	const sub = options.subflow ? [{ id: "sub", kind: "subflow_entry" }, ping("probe")] : [];
	const edges = (chain: { id: string }[]) =>
		chain.slice(1).map((n, i) => ({ from: chain[i]?.id, to: n.id, kind: "chain" }));
	return {
		default_agent: "agent",
		nodes: [...main, ...sub],
		edges: [
			...edges(main),
			...edges(sub),
			...(options.subflow ? [{ from: "spawn", to: "sub", kind: "dispatch" }] : []),
		],
		packages: { "demo-checks": "1.2.0" },
	};
}

/** 推进控制面时钟；每 15 秒心跳一次，手上任务的租约（30 秒）不会过期。 */
export async function advance(clock: ManualClock, agent: FakeAgent, ms: number) {
	for (let left = ms; left > 0; left -= 15_000) {
		clock.advance(Math.min(left, 15_000));
		await agent.heartbeat();
	}
}

/**
 * 视觉回归用的一组运行（开始时间各不相同，顺序确定）：两次成功、一次主链失败、一次取消，
 * 两个进行中（其中一个子流程失败、一个节点带进度）。返回最后一个运行开始的时刻。
 */
export async function seedRunRecords(cp: TestControlPlane, clock: ManualClock, agent: FakeAgent) {
	await publishPackage(cp);
	const daily = await createScenario(cp, "日终数据处理", runDocument({ subflow: true }));
	const stress = await createScenario(cp, "撮合压测", runDocument());
	const login = await createScenario(cp, "登录巡检", runDocument());

	await triggerRun(cp, stress);
	const check = await agent.nextAssign();
	await advance(clock, agent, 20_000);
	await agent.succeed(check);
	const verify = await agent.nextAssign();
	await advance(clock, agent, 70_000);
	await agent.succeed(verify);

	await advance(clock, agent, 60_000);
	await triggerRun(cp, login);
	const refused = await agent.nextAssign();
	await advance(clock, agent, 12_000);
	await agent.fail(refused, "连接被拒绝");

	await advance(clock, agent, 60_000);
	const cancelled = await triggerRun(cp, stress);
	const task = await agent.nextAssign();
	await advance(clock, agent, 30_000);
	await cp.fetch(`/runs/${cancelled}/cancel`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-sfly-nickname": "tester" },
		body: "{}",
	});
	await agent.nextCancel();
	await agent.cancelled(task);

	await advance(clock, agent, 60_000);
	await triggerRun(cp, login);
	const quick = await agent.nextAssign();
	await advance(clock, agent, 8_000);
	await agent.succeed(quick);
	await agent.succeed(await agent.nextAssign());

	await advance(clock, agent, 60_000);
	await triggerRun(cp, daily);
	await agent.succeed(await agent.nextAssign());
	const tasks = [await agent.nextAssign(), await agent.nextAssign()];
	const probe = tasks.find((t) => t.nodeId === "probe");
	const main = tasks.find((t) => t.nodeId === "verify");
	if (!probe || !main) throw new Error("没有派发 verify 与 probe");
	agent.progress(main, 37, 120);
	await agent.fail(probe, "断言失败");

	await advance(clock, agent, 30_000);
	await triggerRun(cp, login);
	await agent.nextAssign();
	return clock.now();
}
