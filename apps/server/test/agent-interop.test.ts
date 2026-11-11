// 互通测试：真实的 Rust Agent（tonic 客户端）用标准 gRPC 连上控制面网关。
import { connect } from "node:net";
import { agentsApi } from "@sfly/schema";
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

	it("Agent 上报它监听的端口，对外地址是控制面看到的连接来源地址，端口能连上", async () => {
		const res = await cp.fetch("/agents");
		const [listed] = agentsApi.list.response.parse(await res.json()).agents;
		expect(listed?.name).toBe("interop-agent");
		expect(listed?.capabilities).toContainEqual({ name: "files", version: 1 });
		expect(listed?.capabilities).toContainEqual({ name: "files.write", version: 1 });
		expect(listed?.capabilities).toContainEqual({ name: "exec", version: 1 });
		const endpoint = listed?.endpoint;
		expect(endpoint).toMatchObject({
			address: "127.0.0.1",
			address_source: "connection",
			unavailable_reason: null,
		});
		// 测试让系统分配端口（support/real-agent.ts）。
		const port = endpoint?.port ?? 0;
		expect(port).toBeGreaterThan(0);
		await new Promise<void>((resolve, reject) => {
			const socket = connect(port, endpoint?.address, () => {
				socket.end();
				resolve();
			});
			socket.once("error", reject);
		});
	});
});
