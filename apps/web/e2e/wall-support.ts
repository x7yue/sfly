import type { Page } from "@playwright/test";
import {
	type AssignedTask,
	ErrorKind,
	type FakeAgent,
} from "../../server/test/support/fake-agent.js";
import type { ManualClock } from "../../server/test/support/manual-clock.js";
import type { TestControlPlane } from "../../server/test/support/test-control-plane.js";
import type { E2eFixtures } from "./fixtures";
import { metricPackage, pingPoints } from "./monitor-scenario";
import {
	createScenario,
	elapseWithHeartbeats,
	publishPackage,
	scenarioUsing,
	triggerRun,
	withSubflow,
} from "./support";

/** 控制台实况墙的端到端测试数据（控制台 e2e 与视觉回归共用）。 */

const ping = (id: string, extra: Record<string, unknown> = {}) => ({
	id,
	kind: "package",
	package: "demo-checks",
	node: "ping",
	inputs: { host: id },
	...extra,
});

/** 由节点排成的一条主链：entry → ids…（都是 demo-checks/ping）。 */
export function mainChain(
	agent: string,
	ids: readonly string[],
	extra: Record<string, unknown>[] = [],
) {
	const nodes = [{ id: "entry", kind: "entry" }, ...ids.map((id, i) => ping(id, extra[i]))];
	return {
		default_agent: agent,
		nodes,
		edges: nodes.slice(1).map((n, i) => ({ from: nodes[i]?.id, to: n.id, kind: "chain" })),
		packages: { "demo-checks": "1.2.0" },
	};
}

/** entry → nap（Sleep 10 分钟）→ ping：等待节点不占 Agent 槽位，进行中的节点那一行写唤醒时间。 */
const withSleep = (agent: string) => ({
	default_agent: agent,
	nodes: [
		{ id: "entry", kind: "entry" },
		{ id: "nap", kind: "sleep", duration: "10m" },
		ping("ping"),
	],
	edges: [
		{ from: "entry", to: "nap", kind: "chain" },
		{ from: "nap", to: "ping", kind: "chain" },
	],
	packages: { "demo-checks": "1.2.0" },
});

/**
 * 固定的一组数据（手动时钟从 2026-01-01T00:00Z，即浏览器里的 08:00 开始；节点包带主指标）：
 * - 巡检成功一次（耗时 2.3s）；一分钟后订单链路的 ping 第 1 次失败、重试的第 2 次超时失败（耗时 4m 12s）；
 * - 一小时后定时巡检停在 Sleep 节点 nap 上，撮合压测开始运行：子流程的 verify 失败，主链的 probe 执行中并上报主指标；
 * - 草稿从没运行过；agent-mac 离线。
 * 返回各运行与场景的 ID，和 agent-linux（probe 在它上面）。
 */
export async function seedWall({
	page,
	controlPlane,
	connectAgent,
	clock,
}: Pick<E2eFixtures, "controlPlane" | "connectAgent" | "clock"> & { page: Page }) {
	const linux = await connectAgent({
		name: "agent-linux",
		os: "linux",
		arch: "x86_64",
		slots: 4,
		installedPackages: [{ name: "demo-checks", version: "1.2.0" }],
	});
	const mac = await connectAgent({ name: "agent-mac", slots: 2 });
	await mac.disconnect();
	await publishPackage(controlPlane, metricPackage());
	const inspect = await createScenario(controlPlane, "巡检", scenarioUsing("agent-linux"));
	const orders = await createScenario(
		controlPlane,
		"订单链路",
		mainChain("agent-linux", ["submit"], [{ retries: 1 }]),
	);
	const timed = await createScenario(controlPlane, "定时巡检", withSleep("agent-linux"));
	const stress = await createScenario(controlPlane, "撮合压测", withSubflow("agent-linux"));
	await createScenario(controlPlane, "草稿");

	const succeeded = await triggerRun(controlPlane, inspect);
	const first = await linux.nextAssign();
	clock.advance(2300);
	await linux.succeed(first);

	clock.advance(60_000);
	const failed = await triggerRun(controlPlane, orders);
	await linux.fail(await linux.nextAssign(), "AssertionError: 子单量 0");
	const retry = await linux.nextAssign();
	await elapseWithHeartbeats(clock, [linux], 252_000);
	await linux.fail(
		retry,
		"等待响应超时：下单接口 30 秒内没有返回，最近一次响应是 503 Service Unavailable，已重试 2 次",
		ErrorKind.TIMEOUT,
	);

	clock.advance(3_600_000);
	const sleeping = await triggerRun(controlPlane, timed);
	clock.advance(5_000);
	const running = await triggerRun(controlPlane, stress);
	const tasks = [await linux.nextAssign(), await linux.nextAssign()];
	const probe = tasks.find((t) => t.nodeId === "probe") as AssignedTask;
	const verify = tasks.find((t) => t.nodeId === "verify") as AssignedTask;
	await linux.fail(verify, "校验失败");
	const clock0 = clock.now().getTime();
	linux.metrics(probe, pingPoints(clock0, 0, 14));
	await linux.sync();
	// 不超过任务租约（30 秒），probe 保持执行中。
	clock.advance(15_000);
	await page.clock.setFixedTime(clock.now());
	return { linux, running, sleeping, failed, succeeded, stress, orders, inspect };
}

/**
 * 很多个运行同时在跑（视觉回归「多个运行」和紧凑行的 e2e）：`count` 个单节点场景各触发一次，Agent 把它们都接下来执行。
 * 每个运行之间隔 1 秒开始，已运行时长各不相同。
 */
export async function manyRuns(
	controlPlane: TestControlPlane,
	agent: FakeAgent,
	clock: ManualClock,
	count: number,
): Promise<string[]> {
	const runs: string[] = [];
	for (let i = 1; i <= count; i++) {
		const scenario = await createScenario(
			controlPlane,
			`浸泡 ${String(i).padStart(2, "0")}`,
			mainChain(agent.name, ["prepare", "soak", "report"]),
		);
		runs.push(await triggerRun(controlPlane, scenario));
		await agent.succeed(await agent.nextAssign());
		await agent.nextAssign();
		clock.advance(1000);
	}
	return runs;
}

/**
 * 30 个节点的长链（视觉回归）：主链 n01…n30，前 14 个成功，n15 执行中；n05 后面的异步任务节点分出子流程「监控」
 * （sub → s1 → s2），s2 执行中。Agent 要有 2 个以上槽位。
 */
export async function longChainRun(
	controlPlane: TestControlPlane,
	agent: FakeAgent,
	clock: ManualClock,
): Promise<string> {
	const ids = Array.from({ length: 30 }, (_, i) => `n${String(i + 1).padStart(2, "0")}`);
	const base = mainChain(agent.name, ids);
	const nodes = [
		...base.nodes.slice(0, 6),
		{ id: "spawn", kind: "async", params: {} },
		...base.nodes.slice(6),
		{ id: "sub", kind: "subflow_entry", name: "监控" },
		ping("s1"),
		ping("s2"),
	];
	const chain = (list: { id: string }[]) =>
		list.slice(1).map((n, i) => ({ from: list[i]?.id, to: n.id, kind: "chain" }));
	const main = nodes.slice(0, 32);
	const scenario = await createScenario(controlPlane, "长链回归", {
		...base,
		nodes,
		edges: [
			...chain(main),
			...chain(nodes.slice(32)),
			{ from: "spawn", to: "sub", kind: "dispatch" },
		],
	});
	const run = await triggerRun(controlPlane, scenario);
	// 主链和子流程并行：做完各自前面的节点，停在 n15 和 s2 上。
	const holding = new Set(["n15", "s2"]);
	while (holding.size > 0) {
		const task = await agent.nextAssign();
		if (holding.delete(task.nodeId)) continue;
		clock.advance(2000);
		await agent.succeed(task);
	}
	return run;
}
