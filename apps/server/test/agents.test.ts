import { afterEach, describe, expect, it } from "vitest";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

interface AgentView {
	name: string;
	status: string;
	info: { agent_version: string; os: string; arch: string; slots: number };
	last_seen_at: string;
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
				info: { agent_version: "1.2.3", os: "linux", arch: "x86_64", slots: 2 },
				last_seen_at: "2026-01-01T00:00:00.000Z",
			},
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
