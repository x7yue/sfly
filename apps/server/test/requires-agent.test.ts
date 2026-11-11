// 节点包声明的最低 Agent 版本（requires_agent，ADR 0019）：用到 Agent 能力的节点包声明它。对节点所在的 Agent 和它通过
// 「Agent」类型的输入引用的 Agent 都检查，阻断时写明是哪台、需要哪个版本：
// - 节点所在的 Agent：触发前比较控制面版本（只给同版本的 Agent 派任务，它会先自更新到控制面的版本，ADR 0014），
//   派发前比较它连接时上报的版本（开发版本在触发前不检查）；
// - 引用的 Agent：比较它最近一次注册时上报的版本——常量在触发前检查，引用入口参数的在触发时按实际值检查，
//   来自前面节点输出的在派发时检查（任务以 env_error 失败）。
// 没有声明的节点包不检查（其余测试里的节点包都没有它）。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { afterEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent, type HelloInit } from "./support/fake-agent.js";
import { packageArchive, packageMetadata, publishInit } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

/** clean(source: AgentName) 与 pick()，声明 requires-agent。 */
const metadata = (overrides: Record<string, unknown> = {}) =>
	packageMetadata({
		name: "logs",
		version: "1.0.0",
		requires_agent: ">=1.1",
		nodes: [
			{
				name: "clean",
				title: "清洗",
				entry: "logs:clean",
				inputs: {
					type: "object",
					properties: { source: { type: "string", "x-sfly-type": "agent" } },
					required: ["source"],
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
		...overrides,
	});

const document = (source: string, extra: { pick?: boolean; version?: string } = {}) => ({
	default_agent: "runner",
	nodes: [
		{ id: "entry", kind: "entry", params: [{ name: "src", type: "string" }] },
		...(extra.pick
			? [{ id: "pick", kind: "package", package: "logs", node: "pick", inputs: {} }]
			: []),
		{ id: "c", kind: "package", package: "logs", node: "clean", inputs: { source } },
	],
	edges: extra.pick
		? [
				{ from: "entry", to: "pick", kind: "chain" },
				{ from: "pick", to: "c", kind: "chain" },
			]
		: [{ from: "entry", to: "c", kind: "chain" }],
	packages: { logs: extra.version ?? "1.0.0" },
});

interface Problem {
	code: string;
	message: string;
	node_id?: string;
}

describe("最低 Agent 版本", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	const agents: FakeAgent[] = [];
	const start = async (version: string) => {
		cp = await startTestControlPlane({ version });
		api = new ApiClient(cp);
	};
	const publish = async () => {
		const res = await cp.fetch("/packages", publishInit(packageArchive(metadata())));
		expect(res.status).toBe(201);
	};
	const connect = async (hello: HelloInit) => {
		const agent = await FakeAgent.connect(cp.grpcUrl, hello);
		agents.push(agent);
		return agent;
	};
	/** 注册过、现在离线的 Agent。 */
	const registerOffline = async (name: string, agentVersion: string) => {
		const agent = await FakeAgent.connect(cp.grpcUrl, { name, agentVersion });
		await agent.close();
	};
	const preflight = async (id: string) =>
		(await api.getJson<{ problems: Problem[] }>(`/orchestrations/${id}/preflight`)).problems;

	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
	});

	it("引用的 Agent 版本太旧时预检阻断，写明是哪台、需要哪个版本；版本够的照常派发", async () => {
		await start("1.1.0");
		await publish();
		const runner = await connect({ name: "runner", agentVersion: "1.1.0" });
		await registerOffline("old-source", "1.0.0");
		await registerOffline("new-source", "1.2.0");

		const blocked = await api.orchestrationWith(document("old-source"));
		expect(await preflight(blocked)).toEqual([
			{
				code: "agent_version_unsatisfied",
				node_id: "c",
				message:
					"节点 c：节点包 logs@1.0.0 需要 Agent >=1.1，参数 source 选的 Agent old-source 的版本是 1.0.0：请升级 Agent old-source",
			},
		]);
		expect((await api.trigger(blocked)).status).toBe(400);
		await runner.expectNoAssign();

		const fine = await api.orchestrationWith(document("new-source"));
		expect(await preflight(fine)).toEqual([]);
		await api.triggerOk(fine);
		expect((await runner.nextAssign()).referencedAgents.map((a) => a.name)).toEqual(["new-source"]);
	});

	it("节点所在的 Agent 按控制面版本判断：控制面版本不满足时请升级控制面", async () => {
		await start("1.0.0");
		await publish();
		await connect({ name: "runner", agentVersion: "1.0.0" });
		await registerOffline("new-source", "1.2.0");

		const id = await api.orchestrationWith(document("new-source"));
		expect(await preflight(id)).toEqual([
			{
				code: "agent_version_unsatisfied",
				node_id: "c",
				message:
					"节点 c：节点包 logs@1.0.0 需要 Agent >=1.1，节点所在的 Agent runner 会先自更新到控制面的版本 1.0.0：请升级控制面",
			},
		]);
	});

	it("引用入口参数时按触发时的实际值检查", async () => {
		await start("1.1.0");
		await publish();
		const runner = await connect({ name: "runner", agentVersion: "1.1.0" });
		await registerOffline("old-source", "1.0.0");
		const id = await api.orchestrationWith(document("${{ params.src }}"));
		expect(await preflight(id)).toEqual([]);

		const rejected = await api.trigger(id, { src: "old-source" });
		expect(rejected.status).toBe(400);
		expect(((await rejected.json()) as { error: unknown }).error).toMatchObject({
			code: "invalid_params",
			message:
				"节点 c：节点包 logs@1.0.0 需要 Agent >=1.1，参数 source 选的 Agent old-source 的版本是 1.0.0：请升级 Agent old-source（取自入口参数）",
			details: [{ code: "agent_version_unsatisfied", node_id: "c" }],
		});
		await runner.expectNoAssign();
	});

	it("值来自前面节点的输出时在派发时检查：引用的 Agent 版本太旧时任务以 env_error 失败", async () => {
		await start("1.1.0");
		await publish();
		const runner = await connect({ name: "runner", agentVersion: "1.1.0" });
		await registerOffline("old-source", "1.0.0");
		const id = await api.orchestrationWith(
			document("${{ nodes.pick.outputs.agent }}", { pick: true }),
		);

		const runId = await api.triggerOk(id);
		await runner.succeed(await runner.nextAssign(), { agent: "old-source" });

		await eventually(async () => {
			const node = await api.node(runId, "c");
			expect(node.status).toBe("failed");
			expect(node.error).toEqual({
				kind: "env_error",
				message:
					"节点 c：节点包 logs@1.0.0 需要 Agent >=1.1，参数 source 选的 Agent old-source 的版本是 1.0.0：请升级 Agent old-source",
			});
		});
		await runner.expectNoAssign();
	});

	it("开发版本在派发时检查节点所在的 Agent：不满足时任务以 env_error 失败，不派给它", async () => {
		await start("1.0.0");
		await registerOffline("new-source", "1.2.0");
		const dev = metadata({ version: "dev" });
		const runner = await connect({
			name: "runner",
			agentVersion: "1.0.0",
			devPackages: [{ name: "logs", source: "/src/logs", metadataJson: JSON.stringify(dev) }],
		});
		const runId = await api.triggerOk(
			await api.orchestrationWith(document("new-source", { version: "dev" })),
		);

		await eventually(async () => {
			const node = await api.node(runId, "c");
			expect(node.status).toBe("failed");
			expect(node.error).toEqual({
				kind: "env_error",
				message:
					"节点包 logs@dev 需要 Agent >=1.1，节点所在的 Agent runner 的版本是 1.0.0：请升级 Agent runner",
			});
		});
		await runner.expectNoAssign();
	});
});
