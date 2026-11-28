// 触发前预检：锁定开发版本（包名@dev）的节点，派发到的 Agent 必须已经用 sfly dev 加载了它（#421，docs/SEMANTICS.md §6、§7）。
// 没有加载时阻断触发，不用等到派发那一步才以 env_error 失败；Agent 不在线时不知道它加载了什么，按离线的规则排队，不阻断。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent, type HelloInit } from "./support/fake-agent.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const devMetadata = (name: string) => ({
	name,
	version: "dev",
	requires_python: ">=3.10",
	nodes: [
		{
			name: "ping",
			title: "Ping",
			entry: `${name}:ping`,
			inputs: { type: "object", properties: {}, required: [] },
			outputs: { type: "object", properties: {} },
		},
	],
});

/** Hello 里上报的开发版本。 */
const loaded = (...names: string[]): Pick<HelloInit, "devPackages"> => ({
	devPackages: names.map((name) => ({
		name,
		source: `/src/${name}`,
		metadataJson: JSON.stringify(devMetadata(name)),
	})),
});

interface Problem {
	code: string;
	message: string;
	node_id?: string;
}

const node = (id: string, pkg: string, extra: Record<string, unknown> = {}) => ({
	id,
	kind: "package",
	package: pkg,
	node: "ping",
	inputs: {},
	...extra,
});

describe("触发前预检：开发版本没有加载", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	const agents: FakeAgent[] = [];
	const connect = async (name: string, init: Pick<HelloInit, "devPackages"> = {}) => {
		const agent = await FakeAgent.connect(cp.grpcUrl, { name, ...init });
		agents.push(agent);
		return agent;
	};
	/** 注册之后断开：库里有这台 Agent（连着它最后一次上报的开发版本），但它不在线。 */
	const registerOffline = async (name: string, init: Pick<HelloInit, "devPackages"> = {}) => {
		const agent = await FakeAgent.connect(cp.grpcUrl, { name, ...init });
		await agent.close();
		await eventually(async () => {
			const { agents: list } = await api.getJson<{ agents: { name: string; status: string }[] }>(
				"/projects/default/agents",
			);
			expect(list.find((a) => a.name === name)?.status).toBe("offline");
		});
	};
	const scenario = (defaultAgent: string, nodes: unknown[], packages: Record<string, string>) =>
		api.orchestrationWith({
			default_agent: defaultAgent,
			nodes: [{ id: "entry", kind: "entry", params: [] }, ...nodes],
			edges: nodes.map((n, i) => ({
				from: i === 0 ? "entry" : (nodes[i - 1] as { id: string }).id,
				to: (n as { id: string }).id,
				kind: "chain",
			})),
			packages,
		});
	const preflight = async (id: string) =>
		(await api.getJson<{ problems: Problem[] }>(`/orchestrations/${id}/preflight`)).problems;
	const rejection = async (res: Response) => {
		expect(res.status).toBe(400);
		const { error } = (await res.json()) as {
			error: { code: string; message: string; details: Problem[] };
		};
		expect(error.code).toBe("invalid_orchestration");
		return error;
	};

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
	});
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
	});

	it("在线的 Agent 没有加载：预检阻断，写明哪个节点、哪台 Agent、缺哪个包，给出 sfly dev 和换 Agent 两条路；触发被拒绝", async () => {
		await connect("agent-plain");
		await connect("agent-dev", loaded("demo-dev"));
		const id = await scenario("agent-plain", [node("a", "demo-dev", { display_name: "探活" })], {
			"demo-dev": "dev",
		});

		const problems = await preflight(id);
		expect(problems).toEqual([
			{
				code: "dev_package_not_loaded",
				node_id: "a",
				message:
					"节点 探活（a） 用的是开发版本 demo-dev@dev，但它派发到的 Agent agent-plain 没有加载：" +
					"在 agent-plain 所在的机器上、节点包源码目录下运行 sfly dev 加载它，或者把这个节点的 Agent 改成已经加载它的 agent-dev",
			},
		]);

		const refused = await rejection(await api.trigger(id));
		expect(refused.details).toEqual(problems);
		const { runs } = await api.getJson<{ runs: unknown[] }>(`/orchestrations/${id}/runs`);
		expect(runs).toEqual([]);
	});

	it("没有别的 Agent 加载了它时，只写在 Agent 所在的机器上运行 sfly dev", async () => {
		await connect("agent-plain");
		const id = await scenario("agent-plain", [node("a", "demo-dev")], { "demo-dev": "dev" });

		expect((await preflight(id)).map((p) => p.message)).toEqual([
			"节点 a 用的是开发版本 demo-dev@dev，但它派发到的 Agent agent-plain 没有加载：在 agent-plain 所在的机器上、节点包源码目录下运行 sfly dev 加载它",
		]);
	});

	it("每个没有加载的节点各列一条，节点另选的 Agent 按它自己判断；已经加载的不报", async () => {
		await connect("agent-plain");
		await connect("agent-dev", loaded("demo-dev"));
		await connect("agent-other", loaded("other-dev"));
		const id = await scenario(
			"agent-dev",
			[
				node("on_default", "demo-dev"),
				node("on_plain", "demo-dev", { agent: "agent-plain" }),
				// 这台 Agent 加载的是别的包，不是这个包。
				node("on_other", "demo-dev", { agent: "agent-other" }),
			],
			{ "demo-dev": "dev" },
		);

		const problems = await preflight(id);
		expect(problems.map((p) => [p.code, p.node_id])).toEqual([
			["dev_package_not_loaded", "on_plain"],
			["dev_package_not_loaded", "on_other"],
		]);
		expect(problems[0]?.message).toContain("Agent agent-plain 没有加载");
		expect(problems[0]?.message).toContain("改成已经加载它的 agent-dev");
		expect(problems[1]?.message).toContain("Agent agent-other 没有加载");
		await rejection(await api.trigger(id));
	});

	it("所有节点的 Agent 都加载了开发版本时不报，照常触发和派发", async () => {
		const first = await connect("agent-a", loaded("demo-dev"));
		await connect("agent-b", loaded("demo-dev", "other-dev"));
		const id = await scenario(
			"agent-a",
			[node("a", "demo-dev"), node("b", "other-dev", { agent: "agent-b" })],
			{
				"demo-dev": "dev",
				"other-dev": "dev",
			},
		);

		expect(await preflight(id)).toEqual([]);
		const runId = await api.triggerOk(id);
		await first.succeed(await first.nextAssign());
		await eventually(async () => expect((await api.node(runId, "a")).status).toBe("success"));
	});

	it("加载的是同一个包就行，Agent 之后加载了它，同一份场景的预检随之放行", async () => {
		const agent = await connect("agent-a");
		const id = await scenario("agent-a", [node("a", "demo-dev")], { "demo-dev": "dev" });
		expect((await preflight(id)).map((p) => p.code)).toEqual(["dev_package_not_loaded"]);

		// sfly dev 加载之后 Agent 用 InstallStatus 上报。
		agent.send({
			case: "install",
			value: {
				package: "demo-dev",
				version: "dev",
				state: 2, // INSTALLED
				taskId: "",
				output: "",
				installedPackages: [{ name: "demo-dev", version: "dev" }],
				devPackages: loaded("demo-dev").devPackages ?? [],
			},
		});
		await eventually(async () => expect(await preflight(id)).toEqual([]));
		await api.triggerOk(id);
	});

	it("Agent 不在线、不知道它加载了什么时按离线的规则处理：不阻断，任务排队等它上线", async () => {
		await registerOffline("agent-off");
		const id = await scenario("agent-off", [node("a", "demo-dev")], { "demo-dev": "dev" });

		expect(await preflight(id)).toEqual([]);
		const runId = await api.triggerOk(id);
		expect((await api.node(runId, "a")).status).toBe("queued");
	});

	it("不在线的 Agent 记录里的开发版本是上次连接时的，不当作现在加载着：既不放行在线的判断，也不列进「已经加载它的 Agent」", async () => {
		await registerOffline("agent-off", loaded("demo-dev"));
		await connect("agent-plain");
		const id = await scenario("agent-plain", [node("a", "demo-dev")], { "demo-dev": "dev" });

		const [problem] = await preflight(id);
		expect(problem?.code).toBe("dev_package_not_loaded");
		expect(problem?.message).not.toContain("agent-off");
	});

	it("已发布的版本不受影响：Agent 没有加载任何开发版本也照常触发", async () => {
		await connect("agent-plain");
		const id = await scenario("agent-plain", [node("a", "demo-checks")], {
			"demo-checks": "1.2.0",
		});
		// 包版本没有发布是另一类问题；这里只看没有开发版本相关的问题。
		expect((await preflight(id)).map((p) => p.code)).not.toContain("dev_package_not_loaded");
	});

	it("开发版本的节点派发到还没有注册的 Agent：只报 Agent 没有注册过，不重复报没有加载", async () => {
		const id = await scenario("agent-ghost", [node("a", "demo-dev")], { "demo-dev": "dev" });

		expect((await preflight(id)).map((p) => p.code)).toEqual(["agent_not_registered"]);
	});
});
