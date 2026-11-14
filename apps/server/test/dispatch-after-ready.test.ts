// 切入点 A（#219）：Agent 连上、收到 Welcome 之后先准备环境，控制面等它准备好（Welcome 之后的第一次心跳）才派发。
// 准备环境期间排队的任务不派发、不计租约，准备再久也不会以 agent_lost 失败。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { FakeAgent } from "./support/fake-agent.js";
import { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const SECOND = 1000;
/** 控制面默认的任务租约。 */
const LEASE = 30 * SECOND;

const orchestration = {
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry" },
		{ id: "a", kind: "package", package: "stub", node: "echo" },
	],
	edges: [{ from: "entry", to: "a", kind: "chain" }],
	packages: { stub: "1.0.0" },
};

describe("Agent 准备好环境之后才派发", () => {
	let clock: ManualClock;
	let cp: TestControlPlane;
	let api: ApiClient;
	const agents: FakeAgent[] = [];

	beforeEach(async () => {
		clock = new ManualClock();
		cp = await startTestControlPlane({ clock });
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: [] });
	});
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
	});

	const preparing = async () => {
		const agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" }, { preparing: true });
		agents.push(agent);
		return agent;
	};

	it("连上但还没发心跳时，任务留在队列里，准备环境超过租约也不会以 agent_lost 失败", async () => {
		const agent = await preparing();
		const runId = await api.triggerOk(await api.orchestrationWith(orchestration));

		await agent.expectNoAssign();
		clock.advance(2 * LEASE + SECOND);
		await agent.expectNoAssign();
		const a = await api.node(runId, "a");
		expect(a.attempts.map((t) => [t.attempt, t.status])).toEqual([[1, "queued"]]);

		// 准备好之后派发的是第 1 次尝试：没有因为准备环境用掉重试。
		await agent.ready();
		const task = await agent.nextAssign();
		expect(task).toMatchObject({ runId, nodeId: "a", attempt: 1 });
		await agent.succeed(task);
		expect((await api.run(runId)).status).toBe("success");
	});

	it("Welcome 之后的第一次心跳一到就按排队顺序派发，不等下一个心跳周期", async () => {
		const agent = await preparing();
		const id = await api.orchestrationWith(orchestration);
		const queued = [];
		for (let i = 0; i < 3; i++) {
			queued.push(await api.triggerOk(id));
			clock.advance(SECOND);
		}
		await agent.expectNoAssign();

		await agent.heartbeat();
		const assigned = [];
		for (let i = 0; i < queued.length; i++) assigned.push((await agent.nextAssign()).runId);
		expect(assigned).toEqual(queued);
	});
});
