import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeAgent } from "./support/fake-agent.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

describe("Agent 网关", () => {
	let cp: TestControlPlane;
	beforeAll(async () => {
		cp = await startTestControlPlane();
	});
	afterAll(async () => {
		await cp.close();
	});

	it("Agent 通过 gRPC 双向流发送 Hello 后收到 Welcome", async () => {
		const agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
		expect(agent.received.map((m) => m.body.case)).toEqual(["welcome"]);
		await agent.close();
		expect(agent.ended).toBe(true);
	});

	it("多个 Agent 可以同时连接", async () => {
		const agents = await Promise.all(
			["a", "b", "c"].map((name) => FakeAgent.connect(cp.grpcUrl, { name })),
		);
		for (const agent of agents) expect(agent.received).toHaveLength(1);
		await Promise.all(agents.map((a) => a.disconnect()));
	});

	it("控制面关闭时连接中的 Agent 流随之结束", async () => {
		const own = await startTestControlPlane();
		const agent = await FakeAgent.connect(own.grpcUrl, { name: "agent-x" });
		await own.close();
		await expect(agent.next(undefined, { timeoutMs: 2000 })).rejects.toThrow();
		expect(agent.ended).toBe(true);
	});
});
