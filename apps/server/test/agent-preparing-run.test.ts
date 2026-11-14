// 切入点 A（#219）：触发运行的人在 Agent 准备环境时能看出来（预检返回的被引用 Agent），
// 排队超时的报错写明真实原因（docs/SEMANTICS.md §3.3 queue_timeout）。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

const orchestration = (defaultAgent: string, nodeAgent?: string) => ({
	default_agent: defaultAgent,
	nodes: [
		{ id: "entry", kind: "entry" },
		{
			id: "a",
			kind: "package",
			package: "stub",
			node: "echo",
			queue_timeout: 120,
			retries: 2,
			...(nodeAgent ? { agent: nodeAgent } : {}),
		},
	],
	edges: [{ from: "entry", to: "a", kind: "chain" }],
	packages: { stub: "1.0.0" },
});

interface PreflightAgent {
	name: string;
	default: boolean;
	status: string;
	preparing_since: string | null;
}

describe("Agent 准备环境时的运行前检查与排队超时报错", () => {
	let clock: ManualClock;
	let cp: TestControlPlane;
	let api: ApiClient;
	const agents: FakeAgent[] = [];

	beforeEach(async () => {
		clock = new ManualClock();
		cp = await startTestControlPlane({ clock });
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: [] });
	});
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
	});

	const connect = async (name: string, opts: { preparing?: boolean } = {}) => {
		const agent = await FakeAgent.connect(cp.grpcUrl, { name }, opts);
		agents.push(agent);
		return agent;
	};
	const preflightAgents = async (id: string) =>
		(await api.getJson<{ agents: PreflightAgent[] }>(`/orchestrations/${id}/preflight`)).agents;

	it("运行前检查返回的被引用 Agent 带 preparing_since：准备环境中是发出 Welcome 的时刻，准备好后为 null", async () => {
		const welcomedAt = clock.now().toISOString();
		const agent = await connect("agent-a", { preparing: true });
		clock.advance(90 * SECOND);
		const id = await api.orchestrationWith(orchestration("agent-a"));

		expect(await preflightAgents(id)).toEqual([
			{ name: "agent-a", default: true, status: "online", preparing_since: welcomedAt },
		]);

		await agent.ready();
		await eventually(async () =>
			expect(await preflightAgents(id)).toEqual([
				{ name: "agent-a", default: true, status: "online", preparing_since: null },
			]),
		);
	});

	it("不在线和没有注册过的被引用 Agent 的 preparing_since 都是 null", async () => {
		const gone = await connect("gone");
		await gone.disconnect();
		agents.splice(agents.indexOf(gone), 1);
		await connect("agent-a", { preparing: true });
		const id = await api.orchestrationWith(orchestration("agent-a", "gone"));

		const refs = await preflightAgents(id);
		expect(refs.map((a) => [a.name, a.status, a.preparing_since === null])).toEqual([
			["agent-a", "online", false],
			["gone", "offline", true],
		]);
	});

	it("Agent 一直在准备环境，排队超过 queue_timeout 后以 env_error 失败，报错写明一直在准备环境，不重试", async () => {
		const agent = await connect("agent-a", { preparing: true });
		const runId = await api.triggerOk(await api.orchestrationWith(orchestration("agent-a")));

		clock.advance(2 * MINUTE - SECOND);
		await agent.expectNoAssign(150);
		expect((await api.node(runId, "a")).status).toBe("queued");

		clock.advance(SECOND);
		await eventually(async () => expect((await api.node(runId, "a")).status).toBe("failed"));
		const a = await api.node(runId, "a");
		expect(a.error?.kind).toBe("env_error");
		expect(a.error?.message).toBe("排队超过 120 秒仍未派发：Agent agent-a 一直在准备环境");
		expect(a.attempts).toHaveLength(1);
	});

	it("Agent 不在线时排队超时，报错原文不变", async () => {
		const gone = await connect("agent-a");
		await gone.disconnect();
		agents.splice(agents.indexOf(gone), 1);
		const runId = await api.triggerOk(await api.orchestrationWith(orchestration("agent-a")));

		clock.advance(2 * MINUTE);
		await eventually(async () => expect((await api.node(runId, "a")).status).toBe("failed"));
		const a = await api.node(runId, "a");
		expect(a.error?.kind).toBe("env_error");
		expect(a.error?.message).toBe("排队超过 120 秒仍未派发：Agent agent-a 不在线或没有空闲槽位");
	});
});
