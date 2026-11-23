// 停用的 Agent 不参与派发（ADR 0029「迁移与过渡」，规格 #492）：预检阻断引用它的场景并写明原因；停用一台正在执行任务的在线 Agent，
// 连接立即断开，它手上的任务按 Agent 失联处理（租约过期后 agent_lost，走现有的重试规则，不新造状态）；恢复之后照常。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import type { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

/** 控制面默认的任务租约。 */
const LEASE_MS = 30_000;

const orchestration = (retries: number) => ({
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry" },
		{ id: "a", kind: "package", package: "stub", node: "echo", retries },
	],
	edges: [{ from: "entry", to: "a", kind: "chain" }],
	packages: { stub: "1.0.0" },
});

interface Preflight {
	problems: { code: string; message: string; node_id?: string }[];
}

describe("停用的 Agent 不参与派发", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	const agents: FakeAgent[] = [];
	const connect = async (name = "agent-a") => {
		const agent = await FakeAgent.connect(cp.grpcUrl, { name });
		agents.push(agent);
		return agent;
	};
	const post = (path: string) => cp.fetch(path, { method: "POST" });

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: [] });
	});
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
	});

	it("预检阻断引用停用 Agent 的场景并写明原因（节点和 Agent 名），触发被拒绝；恢复之后照常", async () => {
		const first = await connect();
		const id = await api.orchestrationWith(orchestration(0));
		expect((await api.getJson<Preflight>(`/orchestrations/${id}/preflight`)).problems).toEqual([]);

		expect((await post("/agents/agent-a/disable")).status).toBe(204);
		await eventually(async () => expect(first.ended).toBe(true));
		const { problems } = await api.getJson<Preflight>(`/orchestrations/${id}/preflight`);
		expect(problems).toEqual([
			expect.objectContaining({
				code: "agent_disabled",
				node_id: "a",
				message: expect.stringMatching(/agent-a.*已被停用/),
			}),
		]);
		const refused = await api.trigger(id);
		expect(refused.status).toBe(400);
		expect(await api.getJson(`/orchestrations/${id}/runs`)).toEqual({ runs: [] });

		expect((await post("/agents/agent-a/enable")).status).toBe(204);
		await connect();
		expect((await api.getJson<Preflight>(`/orchestrations/${id}/preflight`)).problems).toEqual([]);
		await api.triggerOk(id);
	});

	it("停用一台正在执行任务的在线 Agent：连接立即断开，任务在租约过期后以 agent_lost 失败并按 retries 重试；恢复之后第 2 次尝试派下来", async () => {
		const agent = await connect();
		const runId = await api.triggerOk(await api.orchestrationWith(orchestration(1)));
		const task = await agent.nextAssign();
		expect(task).toMatchObject({ runId, nodeId: "a", attempt: 1 });
		await agent.started(task);
		await eventually(async () => expect((await api.node(runId, "a")).status).toBe("running"));

		expect((await post("/agents/agent-a/disable")).status).toBe(204);
		await eventually(async () => expect(agent.ended).toBe(true));
		// 连接断了，但不立刻判失败：和别的失联一样，等租约过期。
		expect((await api.node(runId, "a")).status).toBe("running");
		(cp.clock as ManualClock).advance(LEASE_MS + 1000);
		await eventually(async () => {
			const a = await api.node(runId, "a");
			expect(a.attempts.map((t) => [t.attempt, t.status, t.error?.kind ?? null])).toEqual([
				[1, "failed", "agent_lost"],
				[2, "queued", null],
			]);
		});

		// 停用期间连不上，第 2 次尝试留在队列里；恢复之后重连，派下来。
		await expect(connect()).rejects.toThrow(/停用/);
		expect((await post("/agents/agent-a/enable")).status).toBe(204);
		const again = await connect();
		const second = await again.nextAssign();
		expect(second).toMatchObject({ runId, nodeId: "a", attempt: 2 });
		await again.succeed(second, { text: "ok" });
		await eventually(async () => expect((await api.run(runId)).status).toBe("success"));
	});
});
