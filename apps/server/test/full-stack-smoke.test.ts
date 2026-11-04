// 全栈冒烟：真实的控制面、真实的 Rust Agent、真实的 SDK 执行器，
// 在装好桩节点包的共享 venv 中跑通一条两个节点的链，后一个节点引用前一个节点的输出。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentBinary } from "./support/agent-binary.js";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { createStubVenv, type RealAgent, startRealAgent } from "./support/real-agent.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

describe("全栈冒烟：两个节点的链", () => {
	let cp: TestControlPlane;
	let venv: Awaited<ReturnType<typeof createStubVenv>>;
	let agent: RealAgent;

	beforeAll(async () => {
		const bin = agentBinary();
		[cp, venv] = await Promise.all([startTestControlPlane(), createStubVenv()]);
		agent = await startRealAgent({
			grpcUrl: cp.grpcUrl,
			name: "smoke-agent",
			venv: venv.path,
			bin,
		});
	}, 600_000);

	afterAll(async () => {
		await agent?.close();
		await cp?.close();
		await venv?.remove();
	});

	it("入口参数 → 节点 a → 节点 b（引用 a 的输出），运行成功", async () => {
		const api = new ApiClient(cp);
		const id = await api.orchestrationWith({
			default_agent: "smoke-agent",
			nodes: [
				{ id: "entry", kind: "entry", params: [{ name: "who", type: "string", required: true }] },
				{
					id: "a",
					kind: "package",
					package: "sfly-stub",
					node: "echo",
					inputs: { text: "你好，${{ params.who }}" },
				},
				{
					id: "b",
					kind: "package",
					package: "sfly-stub",
					node: "echo",
					inputs: { text: "${{ nodes.a.outputs.text }}！" },
				},
			],
			edges: [
				{ from: "entry", to: "a", kind: "chain" },
				{ from: "a", to: "b", kind: "chain" },
			],
			packages: { "sfly-stub": "0.1.0" },
		});

		const runId = await api.triggerOk(id, { who: "世界" });

		await eventually(async () => expect((await api.run(runId)).status).toBe("success"), 30_000);
		const a = await api.node(runId, "a");
		const b = await api.node(runId, "b");
		expect(a).toMatchObject({ status: "success", agent: "smoke-agent" });
		expect(a.outputs).toEqual({ text: "你好，世界" });
		expect(b.attempts[0]?.inputs).toEqual({ text: "你好，世界！" });
		expect(b.outputs).toEqual({ text: "你好，世界！" });

		const [registered] = (
			await api.getJson<{ agents: Array<{ info: { installed_packages: unknown } }> }>("/agents")
		).agents;
		expect(registered?.info.installed_packages).toEqual([{ name: "sfly-stub", version: "0.1.0" }]);
	}, 60_000);

	it("节点抛出异常时任务以 node_error 失败，运行失败", async () => {
		const api = new ApiClient(cp);
		const id = await api.orchestrationWith({
			default_agent: "smoke-agent",
			nodes: [
				{ id: "entry", kind: "entry" },
				{
					id: "boom",
					kind: "package",
					package: "sfly-stub",
					node: "fail",
					inputs: { message: "桩节点失败" },
				},
			],
			edges: [{ from: "entry", to: "boom", kind: "chain" }],
			packages: { "sfly-stub": "0.1.0" },
		});

		const runId = await api.triggerOk(id);

		await eventually(async () => expect((await api.run(runId)).status).toBe("failed"), 30_000);
		const node = await api.node(runId, "boom");
		expect(node.status).toBe("failed");
		expect(node.error?.kind).toBe("node_error");
		expect(node.error?.message).toMatch(/^RuntimeError: 桩节点失败/);
	}, 60_000);
});
