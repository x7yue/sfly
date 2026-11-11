// 「Agent」类型的输入（#197，ADR 0019）：节点开发者用 sfly.AgentName 标注的参数，值是 Agent 名称。
// 常量必须是已注册的 Agent（保存时警告，触发时阻断，指出节点和参数）；引用入口参数时触发时按实际值检查
// （子流程里经异步任务节点传入的也一样）；
// 已注册但不在线不阻断。派发时控制面把被引用的 Agent 的名称、地址、端口随任务下发，地址在派发时解析；
// 节点收到的参数值仍是名称。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent, type HelloInit } from "./support/fake-agent.js";
import { packageArchive, packageMetadata, publishInit } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

/** clean(source: AgentName, backup: AgentName | None = None)：sfly build 生成的元信息。 */
const metadata = packageMetadata({
	name: "logs",
	version: "1.0.0",
	nodes: [
		{
			name: "clean",
			title: "清洗",
			entry: "logs:clean",
			inputs: {
				type: "object",
				properties: {
					source: { type: "string", "x-sfly-type": "agent" },
					backup: {
						anyOf: [{ type: "string", "x-sfly-type": "agent" }, { type: "null" }],
						default: null,
					},
				},
				required: ["source"],
				order: ["source", "backup"],
			},
			outputs: { type: "object", properties: {} },
		},
		{
			name: "pick",
			title: "选择",
			entry: "logs:pick",
			inputs: { type: "object", properties: {} },
			outputs: { type: "object", properties: { agent: { type: "string" } } },
		},
	],
});

interface Problem {
	code: string;
	message: string;
	node_id?: string;
}

const document = (inputs: Record<string, unknown>, extra: { pick?: boolean } = {}) => ({
	default_agent: "runner",
	nodes: [
		{ id: "entry", kind: "entry", params: [{ name: "src", type: "string" }] },
		...(extra.pick
			? [{ id: "pick", kind: "package", package: "logs", node: "pick", inputs: {} }]
			: []),
		{ id: "c", kind: "package", package: "logs", node: "clean", inputs },
	],
	edges: extra.pick
		? [
				{ from: "entry", to: "pick", kind: "chain" },
				{ from: "pick", to: "c", kind: "chain" },
			]
		: [{ from: "entry", to: "c", kind: "chain" }],
	packages: { logs: "1.0.0" },
});

describe("「Agent」类型的输入", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	const agents: FakeAgent[] = [];
	const connect = async (hello: HelloInit) => {
		const agent = await FakeAgent.connect(cp.grpcUrl, hello);
		agents.push(agent);
		return agent;
	};
	/** 注册过、现在离线的 Agent。 */
	const registerOffline = async (name: string) => {
		const agent = await FakeAgent.connect(cp.grpcUrl, { name });
		await agent.close();
	};

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		expect((await cp.fetch("/packages", publishInit(packageArchive(metadata)))).status).toBe(201);
	});

	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
	});

	const save = async (doc: unknown) => {
		const id = await api.createOrchestration("t");
		const res = await api.post(`/orchestrations/${id}/versions`, {
			base_version: 0,
			document: doc,
		});
		expect(res.status).toBe(201);
		const { warnings } = (await res.json()) as { warnings: Problem[] };
		return { id, warnings: warnings.filter((w) => w.code.startsWith("agent_")) };
	};
	const preflight = async (id: string) =>
		(await api.getJson<{ problems: Problem[] }>(`/orchestrations/${id}/preflight`)).problems;

	it("常量不是已注册的 Agent：保存时警告，预检阻断并指出节点和参数，不能触发", async () => {
		await connect({ name: "runner" });
		const { id, warnings } = await save(document({ source: "ghost" }));

		const message = "节点 c 的输入 source 选择的 Agent ghost 还没有注册过";
		expect(warnings).toEqual([
			{ code: "agent_input_not_registered", message, node_id: "c", input: "source" },
		]);
		expect(await preflight(id)).toEqual([
			{ code: "agent_input_not_registered", message, node_id: "c" },
		]);
		const res = await api.trigger(id);
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: { message: string } }).error.message).toBe(message);
	});

	it("已注册但不在线的 Agent 不警告、不阻断：照常派发，地址取它上次注册时的", async () => {
		const runner = await connect({ name: "runner" });
		const source = await FakeAgent.connect(cp.grpcUrl, {
			name: "source-a",
			peer: { port: 50052, publicAddress: "10.0.0.5" },
		});
		await source.close();
		const { id, warnings } = await save(document({ source: "source-a" }));

		expect(warnings).toEqual([]);
		expect(await preflight(id)).toEqual([]);
		await api.triggerOk(id);
		const assign = await runner.nextAssign();
		expect(assign.inputs).toEqual({ source: "source-a" });
		expect(
			assign.referencedAgents.map((a) => [a.name, a.address, a.port, a.unavailableReason]),
		).toEqual([["source-a", "10.0.0.5", 50052, ""]]);
	});

	it("引用入口参数时，触发时按实际值检查", async () => {
		const runner = await connect({ name: "runner" });
		await registerOffline("source-a");
		const { id, warnings } = await save(document({ source: "${{ params.src }}" }));
		expect(warnings).toEqual([]);
		expect(await preflight(id)).toEqual([]);

		const rejected = await api.trigger(id, { src: "ghost" });
		expect(rejected.status).toBe(400);
		expect(((await rejected.json()) as { error: unknown }).error).toMatchObject({
			code: "invalid_params",
			message: "节点 c 的输入 source 选择的 Agent ghost 还没有注册过（取自入口参数）",
			details: [{ code: "agent_input_not_registered", node_id: "c" }],
		});
		await runner.expectNoAssign();

		await api.triggerOk(id, { src: "source-a" });
		const assign = await runner.nextAssign();
		expect(assign.inputs).toEqual({ source: "source-a" });
		expect(assign.referencedAgents.map((a) => a.name)).toEqual(["source-a"]);
	});

	it("子流程里引用入口参数的也在触发时按实际值检查：经异步任务节点的参数映射传入", async () => {
		const runner = await connect({ name: "runner" });
		await registerOffline("source-a");
		// 主链 entry → spawn（agent ← 入口参数 src，wait ← 前面节点的输出）；子流程 sub → c（source ← 子流程参数 agent）、
		// d（source ← 子流程参数 wait：触发时不知道，留到派发时）。
		const doc = {
			default_agent: "runner",
			nodes: [
				{ id: "entry", kind: "entry", params: [{ name: "src", type: "string" }] },
				{ id: "pick", kind: "package", package: "logs", node: "pick", inputs: {} },
				{
					id: "spawn",
					kind: "async",
					params: { agent: "${{ params.src }}", wait: "${{ nodes.pick.outputs.agent }}" },
				},
				{
					id: "sub",
					kind: "subflow_entry",
					params: [
						{ name: "agent", type: "string" },
						{ name: "wait", type: "string" },
					],
				},
				{
					id: "c",
					kind: "package",
					package: "logs",
					node: "clean",
					inputs: { source: "${{ params.agent }}" },
				},
				{
					id: "d",
					kind: "package",
					package: "logs",
					node: "clean",
					inputs: { source: "${{ params.wait }}" },
				},
			],
			edges: [
				{ from: "entry", to: "pick", kind: "chain" },
				{ from: "pick", to: "spawn", kind: "chain" },
				{ from: "spawn", to: "sub", kind: "dispatch" },
				{ from: "sub", to: "c", kind: "chain" },
				{ from: "c", to: "d", kind: "chain" },
			],
			packages: { logs: "1.0.0" },
		};
		const { id, warnings } = await save(doc);
		expect(warnings).toEqual([]);
		expect(await preflight(id)).toEqual([]);

		const rejected = await api.trigger(id, { src: "ghost" });
		expect(rejected.status).toBe(400);
		expect(((await rejected.json()) as { error: unknown }).error).toMatchObject({
			code: "invalid_params",
			message:
				"节点 c 的输入 source 选择的 Agent ghost 还没有注册过（取自子流程的参数，由异步任务节点 spawn 传入）",
			details: [{ code: "agent_input_not_registered", node_id: "c" }],
		});
		await runner.expectNoAssign();

		await api.triggerOk(id, { src: "source-a" });
		await runner.succeed(await runner.nextAssign(), { agent: "source-a" });
		const c = await runner.nextAssign();
		expect(c).toMatchObject({ nodeId: "c", inputs: { source: "source-a" } });
		expect(c.referencedAgents.map((a) => a.name)).toEqual(["source-a"]);
	});

	it("派发的任务带有每台被引用 Agent 的名称、地址、端口，不重复；地址取派发时的", async () => {
		const runner = await connect({ name: "runner" });
		const configured = await connect({
			name: "configured",
			peer: { port: 50060, publicAddress: "logs.lan" },
		});
		await connect({ name: "seen", peer: { port: 50061 } });
		await registerOffline("old");
		const { id } = await save(document({ source: "configured", backup: "seen" }));

		await api.triggerOk(id);
		const first = await runner.nextAssign();
		expect(first.inputs).toEqual({ source: "configured", backup: "seen" });
		expect(
			first.referencedAgents.map((a) => [a.name, a.address, a.port, a.unavailableReason]),
		).toEqual([
			["configured", "logs.lan", 50060, ""],
			// 没有配置对外地址：取控制面看到的连接来源地址。
			["seen", "127.0.0.1", 50061, ""],
		]);
		await runner.succeed(first, {});

		// 重新注册换了地址：之后派发的任务用新地址。旧版本 Agent 不监听端口：端口为 0，带上原因。
		await configured.disconnect();
		await connect({ name: "configured", peer: { port: 50070, publicAddress: "10.0.0.9" } });
		const { id: second } = await save(document({ source: "configured", backup: "old" }));
		await api.triggerOk(second);
		const next = await runner.nextAssign();
		expect(
			next.referencedAgents.map((a) => [a.name, a.address, a.port, a.unavailableReason]),
		).toEqual([
			["configured", "10.0.0.9", 50070, ""],
			["old", "127.0.0.1", 0, "Agent 版本过旧，不监听供其它 Agent 连接的端口"],
		]);
	});

	it("值来自前面节点的输出时在派发时检查：没有注册过的 Agent 让任务以 config_error 失败", async () => {
		const runner = await connect({ name: "runner" });
		const { id, warnings } = await save(
			document({ source: "${{ nodes.pick.outputs.agent }}" }, { pick: true }),
		);
		expect(warnings).toEqual([]);

		const runId = await api.triggerOk(id);
		await runner.succeed(await runner.nextAssign(), { agent: "ghost" });

		await eventually(async () => {
			const node = await api.node(runId, "c");
			expect(node.status).toBe("failed");
			expect(node.error).toEqual({
				kind: "config_error",
				message: "节点 c 的输入 source 选择的 Agent ghost 还没有注册过",
			});
		});
		await runner.expectNoAssign();
	});

	it("没有「Agent」类型的输入的任务不带被引用的 Agent", async () => {
		const runner = await connect({ name: "runner" });
		const { id } = await save(document({ source: "runner" }, { pick: true }));
		await api.triggerOk(id);
		const pick = await runner.nextAssign();
		expect(pick.referencedAgents).toEqual([]);
		await runner.succeed(pick, { agent: "x" });
		// 节点自己所在的 Agent 也可以被引用。
		const clean = await runner.nextAssign();
		expect(clean.referencedAgents.map((a) => a.name)).toEqual(["runner"]);
	});
});
