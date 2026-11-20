// 触发前检查（预检和触发时按入口参数的检查）的文案提到节点时写成「显示名称（节点 ID）」（#277）：
// 节点包要求的 SDK 和 Agent 版本、节点派发到的 Agent、「Agent」类型的输入选的 Agent。飞书机器人见 feishu-bot-inputs.test.ts。
import { afterEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { FakeAgent } from "./support/fake-agent.js";
import { packageArchive, packageMetadata, publishInit } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

/** clean(source: AgentName)，要求 SDK 和 Agent 都 >=1.1。 */
const metadata = packageMetadata({
	name: "logs",
	version: "1.0.0",
	requires_sdk: ">=1.1",
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
	],
});

const document = (source: string, defaultAgent = "runner") => ({
	default_agent: defaultAgent,
	nodes: [
		{ id: "entry", kind: "entry", params: [{ name: "src", type: "string" }] },
		{
			id: "c",
			kind: "package",
			package: "logs",
			node: "clean",
			display_name: "清洗日志",
			inputs: { source },
		},
	],
	edges: [{ from: "entry", to: "c", kind: "chain" }],
	packages: { logs: "1.0.0" },
});

interface Problem {
	code: string;
	message: string;
	node_id?: string;
}

describe("触发前检查的文案里的节点", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	const agents: FakeAgent[] = [];

	const start = async (version: string) => {
		cp = await startTestControlPlane({ version });
		api = new ApiClient(cp);
		expect((await cp.fetch("/packages", publishInit(packageArchive(metadata)))).status).toBe(201);
	};
	const connect = async (name: string, agentVersion: string) => {
		const agent = await FakeAgent.connect(cp.grpcUrl, { name, agentVersion });
		agents.push(agent);
		return agent;
	};
	const registerOffline = async (name: string, agentVersion: string) => {
		const agent = await FakeAgent.connect(cp.grpcUrl, { name, agentVersion });
		await agent.close();
	};
	const preflight = async (id: string) =>
		(await api.getJson<{ problems: Problem[] }>(`/orchestrations/${id}/preflight`)).problems;
	const rejection = async (res: Response) => {
		expect(res.status).toBe(400);
		return ((await res.json()) as { error: { message: string } }).error.message;
	};

	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
	});

	it("预检：Agent 没有注册、SDK 版本和节点所在的、被引用的 Agent 版本不满足：节点写成「显示名称（节点 ID）」", async () => {
		await start("1.0.0");
		await registerOffline("old-source", "1.0.0");
		const id = await api.orchestrationWith(document("old-source", "ghost-agent"));

		const problems = await preflight(id);
		expect(problems.map((p) => [p.code, p.node_id])).toEqual([
			["agent_not_registered", "c"],
			["sdk_version_unsatisfied", "c"],
			["agent_version_unsatisfied", "c"],
			["agent_version_unsatisfied", "c"],
		]);
		expect(problems[0]?.message).toBe("节点 清洗日志（c） 派发到的 Agent ghost-agent 还没有注册过");
		expect(problems[1]?.message).toMatch(/^节点 清洗日志（c）：节点包 logs@1.0.0 需要 SDK >=1.1/);
		for (const problem of problems.slice(2)) {
			expect(problem.message).toMatch(/^节点 清洗日志（c）：节点包 logs@1.0.0 需要 Agent >=1.1/);
		}
	});

	it("预检：「Agent」类型的输入选的 Agent 版本太旧", async () => {
		await start("1.1.0");
		await connect("runner", "1.1.0");
		await registerOffline("old-source", "1.0.0");
		const id = await api.orchestrationWith(document("old-source"));

		const problems = await preflight(id);
		expect(problems.map((p) => p.code)).toEqual(["agent_version_unsatisfied"]);
		expect(problems[0]?.message).toMatch(/^节点 清洗日志（c）：节点包 logs@1.0.0 需要 Agent >=1.1/);
	});

	it("触发时按入口参数的实际值检查：Agent 没有注册、版本太旧", async () => {
		await start("1.1.0");
		await connect("runner", "1.1.0");
		await registerOffline("old-source", "1.0.0");
		const id = await api.orchestrationWith(document("${{ params.src }}"));
		expect(await preflight(id)).toEqual([]);

		expect(await rejection(await api.trigger(id, { src: "nobody" }))).toBe(
			"节点 清洗日志（c） 的输入 source 选择的 Agent nobody 还没有注册过（取自入口参数）",
		);
		expect(await rejection(await api.trigger(id, { src: "old-source" }))).toMatch(
			/^节点 清洗日志（c）：节点包 logs@1.0.0 需要 Agent >=1.1.*（取自入口参数）$/,
		);
	});
});
