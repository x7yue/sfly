// 互通测试：真实的 Rust Agent（tonic 客户端）用标准 gRPC 连上控制面网关。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentBinary } from "./support/agent-binary.js";
import { type RealAgent, startRealAgent } from "./support/real-agent.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

describe("Rust Agent 与控制面互通", () => {
	let cp: TestControlPlane;
	let bin: string;
	let agent: RealAgent | undefined;

	beforeAll(async () => {
		bin = agentBinary();
		cp = await startTestControlPlane();
	}, 600_000);

	afterAll(async () => {
		await agent?.close();
		await cp?.close();
	});

	it("Agent 完成 Hello/Welcome 握手", async () => {
		agent = await startRealAgent({ grpcUrl: cp.grpcUrl, name: "interop-agent", bin });
		// 共享 venv 不存在：Agent 先用 uv 创建，再连上控制面。
		expect(agent.events).toEqual([
			{ event: "venv_created", path: expect.stringMatching(/no-venv$/) },
			{ event: "welcome", name: "interop-agent" },
		]);
	}, 30_000);
});
