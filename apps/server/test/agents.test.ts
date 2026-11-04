import { afterEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

interface AgentView {
	name: string;
	status: string;
	info: {
		agent_version: string;
		os: string;
		arch: string;
		slots: number;
		installed_packages: Array<{ name: string; version: string }>;
	};
	last_seen_at: string;
	installed_packages: { name: string; version: string }[];
	running_tasks: {
		task_id: string;
		run_id: string;
		orchestration_id: string;
		node_id: string;
		attempt: number;
		started_at: string;
	}[];
}

async function listAgents(cp: TestControlPlane): Promise<AgentView[]> {
	const res = await cp.fetch("/agents");
	expect(res.status).toBe(200);
	return ((await res.json()) as { agents: AgentView[] }).agents;
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
				installed_packages: [],
				running_tasks: [],
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
				node_id: "a",
				attempt: 1,
				started_at: "2026-01-01T00:00:00.000Z",
			},
		]);
		expect(b?.running_tasks).toEqual([]);

		await agent.succeed(task, {});
		expect((await listAgents(cp))[0]?.running_tasks).toEqual([]);
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
		await expect(FakeAgent.connect(cp.grpcUrl, { name: "anonymous" })).rejects.toThrow(/token/i);
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
