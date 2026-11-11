// 全栈（#197）：真实的控制面、两台 Rust Agent 和 SDK 执行器。节点用 sfly.AgentName 标注参数（testdata/agent-param-package），
// 场景里引用入口参数选择另一台 Agent：节点收到的参数值是 Agent 名称，控制面在派发时把那台 Agent 的地址和端口随任务下发，
// 节点所在的 Agent 用它们连过去（ctx.agent(名称)）；没有注册过的 Agent 在触发时就被拒绝。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { agentsApi } from "@sfly/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentBinary } from "./support/agent-binary.js";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { createStubVenv, type RealAgent, startRealAgent } from "./support/real-agent.js";
import { publishTestPackage } from "./support/stub-package.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

describe("全栈：「Agent」类型的输入", () => {
	let cp: TestControlPlane;
	const venvs: Awaited<ReturnType<typeof createStubVenv>>[] = [];
	const agents: RealAgent[] = [];

	beforeAll(async () => {
		const bin = agentBinary();
		let runnerVenv: (typeof venvs)[number];
		let sourceVenv: (typeof venvs)[number];
		[cp, runnerVenv, sourceVenv] = await Promise.all([
			startTestControlPlane(),
			createStubVenv({ sdkOnly: true }),
			createStubVenv({ sdkOnly: true }),
		]);
		venvs.push(runnerVenv, sourceVenv);
		await publishTestPackage(cp, "testdata/agent-param-package", "sfly-agent-param-0.1.0.sflypkg");
		agents.push(
			...(await Promise.all([
				startRealAgent({ grpcUrl: cp.grpcUrl, name: "fs-runner", venv: runnerVenv.path, bin }),
				startRealAgent({ grpcUrl: cp.grpcUrl, name: "fs-source", venv: sourceVenv.path, bin }),
			])),
		);
	}, 600_000);

	afterAll(async () => {
		await Promise.all(agents.map((a) => a.close()));
		await cp?.close();
		await Promise.all(venvs.map((v) => v.remove()));
	});

	it("节点收到 Agent 名称，并用控制面派发时解析的地址和端口访问那台 Agent", async () => {
		const api = new ApiClient(cp);
		const listed = agentsApi.list.response.parse(await (await cp.fetch("/agents")).json()).agents;
		const endpoint = listed.find((a) => a.name === "fs-source")?.endpoint;
		expect(endpoint?.port).toBeGreaterThan(0);

		const id = await api.orchestrationWith({
			default_agent: "fs-runner",
			nodes: [
				{ id: "entry", kind: "entry", params: [{ name: "src", type: "string", required: true }] },
				{
					id: "reach",
					kind: "package",
					package: "sfly-agent-param",
					node: "reach",
					inputs: { source: "${{ params.src }}" },
				},
			],
			edges: [{ from: "entry", to: "reach", kind: "chain" }],
			packages: { "sfly-agent-param": "0.1.0" },
		});

		const rejected = await api.trigger(id, { src: "ghost" });
		expect(rejected.status).toBe(400);

		const runId = await api.triggerOk(id, { src: "fs-source" });
		await eventually(async () => expect((await api.run(runId)).status).toBe("success"), 60_000);
		expect((await api.node(runId, "reach")).outputs).toEqual({ source: "fs-source", reached: "/" });
	}, 120_000);
});
