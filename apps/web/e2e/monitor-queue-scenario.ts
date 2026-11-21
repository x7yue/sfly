import type { FakeAgent } from "../../server/test/support/fake-agent.js";
import type { ManualClock } from "../../server/test/support/manual-clock.js";
import type { TestControlPlane } from "../../server/test/support/test-control-plane.js";
import type { E2eFixtures } from "./fixtures";
import { expect } from "./fixtures";
import { createScenario, publishPackage, triggerRun } from "./support";

// 排队中的节点在等什么：端到端测试与视觉回归共用的场景。

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;

/** entry → a（排队超时 5 分钟，显示名称「准备环境」）。 */
export const queueScenario = (agent: string) => ({
	default_agent: agent,
	nodes: [
		{ id: "entry", kind: "entry", params: [] },
		{
			id: "a",
			kind: "package",
			package: "demo-checks",
			node: "ping",
			inputs: { host: "h" },
			queue_timeout: 300,
			display_name: "准备环境",
		},
	],
	edges: [{ from: "entry", to: "a", kind: "chain" }],
	packages: { "demo-checks": "1.2.0" },
});

/** 断开 Agent，等控制面把它记为离线（最后在线的时间就是这一刻，之后才推进时钟）。 */
export async function goOffline(
	controlPlane: TestControlPlane,
	agent: Pick<FakeAgent, "disconnect">,
	name: string,
) {
	await agent.disconnect();
	await expect
		.poll(async () => {
			const list = (await (await controlPlane.fetch("/agents")).json()) as {
				agents: Array<{ name: string; status: string }>;
			};
			return list.agents.find((a) => a.name === name)?.status;
		})
		.toBe("offline");
}

const INSTALLED = [{ name: "demo-checks", version: "1.2.0" }];

/**
 * 节点 a 在等一台不在线的 Agent：agent-a 在线 30 秒后断开，过 2 分钟触发运行，再过 5 秒。
 * 概览上写「等 agent-a（不在线，已离线 2m 05s）· 排队 5s · 4m 55s 后超时」。另有一台在线的 agent-b。
 */
export async function queuedOffline(
	controlPlane: TestControlPlane,
	connectAgent: E2eFixtures["connectAgent"],
	clock: ManualClock,
): Promise<{ runId: string }> {
	await publishPackage(controlPlane);
	const agent = await connectAgent({ name: "agent-a", slots: 2, installedPackages: INSTALLED });
	await connectAgent({ name: "agent-b", slots: 2 });
	clock.advance(30 * SECOND);
	await goOffline(controlPlane, agent, "agent-a");
	clock.advance(2 * MINUTE);
	const scenarioId = await createScenario(controlPlane, "准备环境场景", queueScenario("agent-a"));
	const runId = await triggerRun(controlPlane, scenarioId);
	clock.advance(5 * SECOND);
	return { runId };
}

/**
 * agent-a 只有 1 个槽位，被另一次运行的节点 a 占着（执行中）；这次运行的节点 a 在排队，10 秒前进的队。
 */
export async function queuedSlotsFull(
	controlPlane: TestControlPlane,
	connectAgent: E2eFixtures["connectAgent"],
	clock: ManualClock,
): Promise<{ runId: string }> {
	await publishPackage(controlPlane);
	const agent = await connectAgent({ name: "agent-a", slots: 1, installedPackages: INSTALLED });
	const scenarioId = await createScenario(controlPlane, "准备环境场景", queueScenario("agent-a"));
	await triggerRun(controlPlane, scenarioId);
	await agent.nextAssign();
	const runId = await triggerRun(controlPlane, scenarioId);
	clock.advance(10 * SECOND);
	return { runId };
}
