import { type AgentView, agentsApi } from "@sfly/schema";
import { afterEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import type { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

/** 旧版本 Agent 不监听端口时，能力不能被其它 Agent 调用的原因。 */
const OLD_AGENT_REASON = "Agent 版本过旧，不监听供其它 Agent 连接的端口";

/** Agent 列表；响应按契约解析（不符合契约时测试失败）。 */
async function listAgents(cp: TestControlPlane): Promise<AgentView[]> {
	const res = await cp.fetch("/projects/default/agents");
	expect(res.status).toBe(200);
	return agentsApi.list.response.parse(await res.json()).agents;
}

describe("Agent 注册", () => {
	let cp: TestControlPlane | undefined;
	const agents: FakeAgent[] = [];
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp?.close();
		cp = undefined;
	});

	it("Agent 通过 Hello 按名称注册，上报的信息可以通过 API 查到", async () => {
		cp = await startTestControlPlane();
		agents.push(
			await FakeAgent.connect(cp.grpcUrl, {
				name: "agent-a",
				agentVersion: "1.2.3",
				os: "linux",
				arch: "x86_64",
				slots: 2,
			}),
		);

		expect(await listAgents(cp)).toEqual([
			{
				name: "agent-a",
				status: "online",
				info: {
					agent_version: "1.2.3",
					os: "linux",
					arch: "x86_64",
					slots: 2,
					installed_packages: [],
				},
				last_seen_at: "2026-01-01T00:00:00.000Z",
				// 假 Agent 连上后立即发出第一次心跳：已准备好环境。
				preparing_since: null,
				clock_offset: null,
				installed_packages: [],
				install: null,
				dev_packages: [],
				running_tasks: [],
				queued_tasks: [],
				// 控制面是 package.json 的版本，与 1.2.3 不一致。
				version_mismatch: true,
				update: { state: "none", remaining_tasks: 0, reason: "" },
				referencing_orchestrations: 0,
				// 假 Agent 默认用 Agent 凭据连接；没有停用。
				auth_kind: "agent",
				disabled_at: null,
				// 不上报端口和能力的旧版本 Agent（ADR 0019）。
				capabilities: [],
				endpoint: {
					address: "127.0.0.1",
					address_source: "connection",
					port: null,
					unavailable_reason: OLD_AGENT_REASON,
				},
			},
		]);
	});

	it("Hello 上报的已安装节点包可以通过 API 查到，重新连接时更新", async () => {
		cp = await startTestControlPlane();
		const first = await FakeAgent.connect(cp.grpcUrl, {
			name: "agent-a",
			installedPackages: [
				{ name: "sfly-stub", version: "0.1.0" },
				{ name: "demo", version: "2.0.0" },
			],
		});
		agents.push(first);
		const reported = [
			{ name: "sfly-stub", version: "0.1.0" },
			{ name: "demo", version: "2.0.0" },
		];
		const [listed] = await listAgents(cp);
		expect(listed?.info.installed_packages).toEqual(reported);
		expect(listed?.installed_packages).toEqual(reported);

		agents.push(
			await FakeAgent.connect(cp.grpcUrl, {
				name: "agent-a",
				installedPackages: [{ name: "sfly-stub", version: "0.2.0" }],
			}),
		);
		const [relisted] = await listAgents(cp);
		expect(relisted?.info.installed_packages).toEqual([{ name: "sfly-stub", version: "0.2.0" }]);
		expect(relisted?.installed_packages).toEqual([{ name: "sfly-stub", version: "0.2.0" }]);
	});

	it("Agent 列表显示正在它上面运行的任务，任务结束后消失", async () => {
		cp = await startTestControlPlane();
		const api = new ApiClient(cp);
		const agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
		agents.push(agent);
		agents.push(await FakeAgent.connect(cp.grpcUrl, { name: "agent-b" }));
		await publishPackage(cp, "stub", "1.0.0", { echo: [] });
		const orchestrationId = await api.orchestrationWith({
			default_agent: "agent-a",
			nodes: [
				{ id: "entry", kind: "entry" },
				{ id: "a", kind: "package", package: "stub", node: "echo" },
			],
			edges: [{ from: "entry", to: "a", kind: "chain" }],
			packages: { stub: "1.0.0" },
		});
		const runId = await api.triggerOk(orchestrationId);
		const task = await agent.nextAssign();

		const [a, b] = await listAgents(cp);
		expect(a?.running_tasks).toEqual([
			{
				task_id: task.taskId,
				run_id: runId,
				orchestration_id: orchestrationId,
				orchestration_name: "test",
				node_id: "a",
				node_type: "stub/echo",
				chain_instance_id: (await api.run(runId)).chains[0]?.id,
				chain_name: null,
				attempt: 1,
				status: "running",
				started_at: "2026-01-01T00:00:00.000Z",
				current_action: null,
				progress: null,
			},
		]);
		expect(b?.running_tasks).toEqual([]);
		expect(a?.queued_tasks).toEqual([]);

		await agent.succeed(task, {});
		expect((await listAgents(cp))[0]?.running_tasks).toEqual([]);
	});

	it("Agent 列表里正在执行的任务带最新进度（说明里的 secret 值打码），没上报过时为 null", async () => {
		const own = await startTestControlPlane();
		cp = own;
		const api = new ApiClient(own);
		const agent = await FakeAgent.connect(own.grpcUrl, { name: "agent-a" }, { clock: own.clock });
		agents.push(agent);
		await publishPackage(own, "stub", "1.0.0", { echo: [] });
		await api.triggerOk(
			await api.orchestrationWith({
				default_agent: "agent-a",
				nodes: [
					{
						id: "entry",
						kind: "entry",
						params: [{ name: "token", type: "string", default: "tk-secret", secret: true }],
					},
					{ id: "a", kind: "package", package: "stub", node: "echo" },
				],
				edges: [{ from: "entry", to: "a", kind: "chain" }],
				packages: { stub: "1.0.0" },
			}),
		);
		const task = await agent.nextAssign();
		const progressOf = async () => (await listAgents(own))[0]?.running_tasks.map((t) => t.progress);
		expect(await progressOf()).toEqual([null]);

		agent.progress(task, 3, 10, "第 3 批，令牌 tk-secret");
		await eventually(async () =>
			expect(await progressOf()).toEqual([
				{
					current: 3,
					total: 10,
					message: "第 3 批，令牌 ******",
					time: "2026-01-01T00:00:00.000Z",
					agent_time: "2026-01-01T00:00:01.000Z",
				},
			]),
		);
		await agent.succeed(task, {});
		expect(await progressOf()).toEqual([]);
	});

	it("Agent 列表里的任务带场景的现在的名称、所在的链实例和子流程名称（主链没有）", async () => {
		cp = await startTestControlPlane();
		const api = new ApiClient(cp);
		const agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
		agents.push(agent);
		await publishPackage(cp, "stub", "1.0.0", { echo: [] });
		const echo = (id: string) => ({ id, kind: "package", package: "stub", node: "echo" });
		const orchestrationId = await api.orchestrationWith(
			{
				default_agent: "agent-a",
				nodes: [
					{ id: "entry", kind: "entry" },
					{ id: "spawn", kind: "async", params: {} },
					echo("main"),
					{ id: "sub", kind: "subflow_entry", name: "巡检子流程" },
					echo("inside"),
				],
				edges: [
					{ from: "entry", to: "spawn", kind: "chain" },
					{ from: "spawn", to: "main", kind: "chain" },
					{ from: "sub", to: "inside", kind: "chain" },
					{ from: "spawn", to: "sub", kind: "dispatch" },
				],
				packages: { stub: "1.0.0" },
			},
			"撮合浸泡",
		);
		const runId = await api.triggerOk(orchestrationId);
		await agent.nextAssign();
		await agent.nextAssign();

		const view = await api.run(runId);
		const mainChain = view.chains.find((c) => c.depth === 0);
		const subflow = view.chains.find((c) => c.depth > 0);
		const [listed] = await listAgents(cp);
		expect(listed?.running_tasks).toHaveLength(2);
		const byNode = (nodeId: string) => listed?.running_tasks.find((t) => t.node_id === nodeId);
		expect(byNode("main")).toMatchObject({
			orchestration_name: "撮合浸泡",
			chain_instance_id: mainChain?.id,
			chain_name: null,
		});
		expect(byNode("inside")).toMatchObject({
			orchestration_name: "撮合浸泡",
			chain_instance_id: subflow?.id,
			chain_name: "巡检子流程",
		});

		// 场景改名后，列表里是现在的名称（名称不跟版本走）。
		const rename = await api.patch(`/orchestrations/${orchestrationId}`, {
			name: "撮合浸泡 · 改名",
		});
		expect(rename.status).toBe(200);
		expect((await listAgents(cp))[0]?.running_tasks[0]?.orchestration_name).toBe("撮合浸泡 · 改名");
	});

	describe("排队的任务", () => {
		const node = (id: string, queueTimeout?: number) => ({
			id,
			kind: "package",
			package: "stub",
			node: "echo",
			...(queueTimeout === undefined ? {} : { queue_timeout: queueTimeout }),
		});
		const single = (agent: string, ...nodes: ReturnType<typeof node>[]) => ({
			default_agent: agent,
			nodes: [{ id: "entry", kind: "entry" }, ...nodes],
			edges: nodes.map((n, i) => ({
				from: i === 0 ? "entry" : nodes[i - 1]?.id,
				to: n.id,
				kind: "chain",
			})),
			packages: { stub: "1.0.0" },
		});

		it("没有空闲槽位的任务在 queued_tasks 里，按排队顺序，带排队时间和排队超时；开始执行后移到 running_tasks", async () => {
			cp = await startTestControlPlane();
			const clock = cp.clock as ManualClock;
			const api = new ApiClient(cp);
			const agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 1 });
			agents.push(agent);
			await publishPackage(cp, "stub", "1.0.0", { echo: [] });
			const id = await api.orchestrationWith(single("agent-a", node("a", 30)), "巡检");
			const first = await api.triggerOk(id);
			const running = await agent.nextAssign();
			clock.advance(5_000);
			const second = await api.triggerOk(id);
			clock.advance(7_000);
			const third = await api.triggerOk(id);

			const [listed] = await listAgents(cp);
			expect(listed?.running_tasks.map((t) => t.run_id)).toEqual([first]);
			expect(listed?.queued_tasks).toEqual([
				{
					task_id: expect.any(String),
					run_id: second,
					orchestration_id: id,
					orchestration_name: "巡检",
					node_id: "a",
					node_type: "stub/echo",
					chain_instance_id: (await api.run(second)).chains[0]?.id,
					chain_name: null,
					attempt: 1,
					queued_at: "2026-01-01T00:00:05.000Z",
					queue_expires_at: "2026-01-01T00:00:35.000Z",
				},
				expect.objectContaining({
					run_id: third,
					queued_at: "2026-01-01T00:00:12.000Z",
					queue_expires_at: "2026-01-01T00:00:42.000Z",
				}),
			]);

			await agent.succeed(running, {});
			await agent.nextAssign();
			const [next] = await listAgents(cp);
			expect(next?.running_tasks.map((t) => t.run_id)).toEqual([second]);
			expect(next?.queued_tasks.map((t) => t.run_id)).toEqual([third]);
		});

		it("Agent 不在线时排队的任务照样列在它名下；排队超时失败后从列表里消失", async () => {
			cp = await startTestControlPlane();
			const clock = cp.clock as ManualClock;
			const api = new ApiClient(cp);
			const offline = await FakeAgent.connect(cp.grpcUrl, { name: "agent-b" });
			await offline.disconnect();
			const own = cp;
			await eventually(async () => expect((await listAgents(own))[0]?.status).toBe("offline"));
			await publishPackage(cp, "stub", "1.0.0", { echo: [] });
			const id = await api.orchestrationWith(single("agent-b", node("a", 20)));
			const runId = await api.triggerOk(id);

			await eventually(async () => {
				const [listed] = await listAgents(own);
				expect(listed).toMatchObject({ name: "agent-b", status: "offline", running_tasks: [] });
				expect(listed?.queued_tasks).toMatchObject([
					{ run_id: runId, queue_expires_at: "2026-01-01T00:00:20.000Z" },
				]);
			});

			clock.advance(20_000);
			await eventually(async () => expect((await listAgents(own))[0]?.queued_tasks).toEqual([]));
			expect((await api.run(runId)).status).toBe("failed");
		});
	});

	it("Agent 列表里的任务带节点的显示名称（取自运行绑定的版本，之后改名不影响），没有显示名称的节点不带", async () => {
		cp = await startTestControlPlane();
		const api = new ApiClient(cp);
		const agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
		agents.push(agent);
		await publishPackage(cp, "stub", "1.0.0", { echo: [] });
		const document = (name: string) => ({
			default_agent: "agent-a",
			nodes: [
				{ id: "entry", kind: "entry" },
				{ id: "a", kind: "package", package: "stub", node: "echo", display_name: name },
				{ id: "b", kind: "package", package: "stub", node: "echo" },
			],
			edges: [
				{ from: "entry", to: "a", kind: "chain" },
				{ from: "a", to: "b", kind: "chain" },
			],
			packages: { stub: "1.0.0" },
		});
		const orchestrationId = await api.orchestrationWith(document("创建测试用户"));
		await api.triggerOk(orchestrationId);
		const first = await agent.nextAssign();
		await api.saveVersion(orchestrationId, document("改过的名字"));

		const [running] = await listAgents(cp);
		expect(running?.running_tasks).toMatchObject([{ node_id: "a", display_name: "创建测试用户" }]);

		await agent.succeed(first, {});
		await agent.nextAssign();
		const [next] = await listAgents(cp);
		expect(next?.running_tasks).toMatchObject([{ node_id: "b" }]);
		expect(next?.running_tasks[0]).not.toHaveProperty("display_name");
	});

	it("Agent 列表返回被多少个场景引用：最新版本里的默认 Agent 或节点另选的 Agent", async () => {
		cp = await startTestControlPlane();
		const api = new ApiClient(cp);
		for (const name of ["agent-a", "agent-b", "agent-c"]) {
			agents.push(await FakeAgent.connect(cp.grpcUrl, { name }));
		}
		const doc = (defaultAgent: string | undefined, nodeAgents: string[]) => ({
			...(defaultAgent ? { default_agent: defaultAgent } : {}),
			nodes: [
				{ id: "entry", kind: "entry" },
				...nodeAgents.map((agent, i) => ({
					id: `p${i}`,
					kind: "package",
					package: "demo-checks",
					node: "ping",
					agent,
				})),
			],
			edges: [],
		});
		// 旧版本引用 agent-c，最新版本不再引用：只算最新版本。
		const changed = await api.orchestrationWith(doc("agent-c", []), "changed");
		await api.saveVersion(changed, doc("agent-a", ["agent-b"]));
		// 默认 Agent 与节点另选同一个 Agent 时只算一次。
		await api.orchestrationWith(doc("agent-a", ["agent-a", "agent-a"]), "same");
		await api.orchestrationWith(doc(undefined, ["agent-b"]), "node-only");
		await api.createOrchestration("no-version");

		const counts = (await listAgents(cp)).map((a) => [a.name, a.referencing_orchestrations]);
		expect(counts).toEqual([
			["agent-a", 2],
			["agent-b", 2],
			["agent-c", 0],
		]);
	});

	it("未上报槽位数时使用默认的 4 个槽位", async () => {
		cp = await startTestControlPlane();
		agents.push(await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" }));
		const [agent] = await listAgents(cp);
		expect(agent?.info.slots).toBe(4);
	});

	it("同名 Agent 重新连接时替换旧连接", async () => {
		cp = await startTestControlPlane();
		const old = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", agentVersion: "1" });
		agents.push(old);
		const fresh = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", agentVersion: "2" });
		agents.push(fresh);

		await eventually(async () => expect(old.ended).toBe(true));
		expect(fresh.ended).toBe(false);
		const list = await listAgents(cp);
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({ name: "agent-a", status: "online" });
		expect(list[0]?.info.agent_version).toBe("2");
	});

	it("Agent 断开后显示为离线；被替换的旧连接断开不影响新连接", async () => {
		cp = await startTestControlPlane();
		const old = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
		const fresh = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
		await old.disconnect();
		await eventually(async () => expect(old.ended).toBe(true));
		expect((await listAgents(cp))[0]?.status).toBe("online");

		await fresh.disconnect();
		const own = cp;
		await eventually(async () => expect((await listAgents(own))[0]?.status).toBe("offline"));
	});

	it("配置了共享注册令牌时，令牌不对的 Agent 被拒绝且不会注册", async () => {
		cp = await startTestControlPlane({ agentToken: "s3cret" });

		await expect(
			FakeAgent.connect(cp.grpcUrl, { name: "intruder", token: "wrong" }),
		).rejects.toThrow(/token/i);
		// 没写 token 的假 Agent 默认用 Agent 凭据连接：要测「没有凭据」，Hello 里写空的 token。
		await expect(FakeAgent.connect(cp.grpcUrl, { name: "anonymous", token: "" })).rejects.toThrow(
			/token/i,
		);
		expect(await listAgents(cp)).toEqual([]);

		agents.push(await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", token: "s3cret" }));
		expect((await listAgents(cp)).map((a) => a.name)).toEqual(["agent-a"]);
	});

	it("第一条消息不是 Hello 时拒绝连接", async () => {
		cp = await startTestControlPlane();
		await expect(
			FakeAgent.connectRaw(cp.grpcUrl, (agent) =>
				agent.send({ case: "result", value: { taskId: "x", attempt: 1 } }),
			),
		).rejects.toThrow(/hello/i);
	});
});

describe("Agent 的对外地址、端口与能力（ADR 0019）", () => {
	let cp: TestControlPlane | undefined;
	const agents: FakeAgent[] = [];
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp?.close();
		cp = undefined;
	});

	const agentNamed = async (name: string) => {
		const found = (await listAgents(cp as TestControlPlane)).find((a) => a.name === name);
		if (!found) throw new Error(`agent ${name} not listed`);
		return found;
	};

	it("没有显式配置对外地址时，对外地址是控制面看到的连接来源地址；能力按上报的列出", async () => {
		cp = await startTestControlPlane();
		agents.push(
			await FakeAgent.connect(cp.grpcUrl, {
				name: "agent-a",
				capabilities: [
					{ name: "files", version: 2 },
					{ name: "exec", version: 1 },
				],
				peer: { port: 50052 },
			}),
		);

		const agent = await agentNamed("agent-a");
		expect(agent.endpoint).toEqual({
			address: "127.0.0.1",
			address_source: "connection",
			port: 50052,
			unavailable_reason: null,
		});
		expect(agent.capabilities).toEqual([
			{ name: "files", version: 2 },
			{ name: "exec", version: 1 },
		]);
	});

	it("显式配置了对外地址时以配置为准；重新连接后按新上报的更新", async () => {
		cp = await startTestControlPlane();
		agents.push(
			await FakeAgent.connect(cp.grpcUrl, {
				name: "agent-a",
				peer: { port: 6000, publicAddress: "10.0.0.5" },
			}),
		);
		expect((await agentNamed("agent-a")).endpoint).toEqual({
			address: "10.0.0.5",
			address_source: "configured",
			port: 6000,
			unavailable_reason: null,
		});

		// 去掉配置后重新连接：回到连接来源地址。
		agents.push(await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", peer: { port: 6001 } }));
		expect((await agentNamed("agent-a")).endpoint).toMatchObject({
			address: "127.0.0.1",
			address_source: "connection",
			port: 6001,
		});
	});

	it("端口被占用的 Agent：照常接任务，能力不能被其它 Agent 调用，并给出原因", async () => {
		cp = await startTestControlPlane();
		const api = new ApiClient(cp);
		const agent = await FakeAgent.connect(cp.grpcUrl, {
			name: "agent-a",
			peer: { port: 50052, listenError: "端口 50052 已被占用" },
		});
		agents.push(agent);

		expect((await agentNamed("agent-a")).endpoint).toEqual({
			address: "127.0.0.1",
			address_source: "connection",
			port: 50052,
			unavailable_reason: "端口 50052 已被占用",
		});
		await publishPackage(cp, "stub", "1.0.0", { echo: [] });
		const runId = await api.triggerOk(await api.orchestrationWith(echoOn("agent-a")));
		await agent.succeed(await agent.nextAssign(), {});
		await eventually(async () => expect((await api.run(runId)).status).toBe("success"));
	});

	it("新控制面配旧 Agent：不上报端口和能力的 Agent 照常注册、执行任务", async () => {
		cp = await startTestControlPlane();
		const api = new ApiClient(cp);
		const agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-old" });
		agents.push(agent);

		const listed = await agentNamed("agent-old");
		expect(listed.capabilities).toEqual([]);
		expect(listed.endpoint).toEqual({
			address: "127.0.0.1",
			address_source: "connection",
			port: null,
			unavailable_reason: OLD_AGENT_REASON,
		});
		await publishPackage(cp, "stub", "1.0.0", { echo: [] });
		const runId = await api.triggerOk(await api.orchestrationWith(echoOn("agent-old")));
		await agent.succeed(await agent.nextAssign(), {});
		await eventually(async () => expect((await api.run(runId)).status).toBe("success"));
	});
});

/** 在 `agent` 上执行一个 stub.echo 节点的场景文档。 */
function echoOn(agent: string) {
	return {
		default_agent: agent,
		nodes: [
			{ id: "entry", kind: "entry" },
			{ id: "a", kind: "package", package: "stub", node: "echo" },
		],
		edges: [{ from: "entry", to: "a", kind: "chain" }],
		packages: { stub: "1.0.0" },
	};
}
