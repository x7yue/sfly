// 停用的 Agent 不参与派发（ADR 0029「迁移与过渡」，规格 #492）：预检阻断引用它的场景并写明原因；停用一台正在执行任务的在线 Agent，
// 连接立即断开，它手上的任务按 Agent 失联处理（租约过期后 agent_lost，走现有的重试规则，不新造状态）；恢复之后照常。
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { bearer, TestAccounts } from "./support/credentials.js";
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
	/** 停用、恢复要凭据（现在就要，不等 #494）：项目管理员的个人令牌。 */
	let accounts: TestAccounts;
	let admin: Record<string, string>;
	const post = (path: string) => cp.fetch(path, { method: "POST", headers: admin });

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		accounts = new TestAccounts(cp.database.url);
		const boss = await accounts.user("boss");
		await accounts.member("default", boss, "project_admin");
		admin = bearer(await accounts.personalToken(boss));
		await publishPackage(cp, "stub", "1.0.0", { echo: [] });
	});
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await accounts.close();
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

	it("预检里停用只看这个项目里的 Agent：别的项目里同名的、被停用的和没有注册过一样（agent_not_registered，不说停用）；这个项目里被停用的是 agent_disabled", async () => {
		await accounts.project("alpha");
		const db = new pg.Client({ connectionString: cp.database.url });
		await db.connect();
		try {
			const alpha = await FakeAgent.connect(cp.grpcUrl, {
				name: "agent-b",
				token: (await cp.current.agentCredentials.issue("alpha" as never, "agent-b")).token,
			});
			agents.push(alpha);
			const id = await api.orchestrationWith({ ...orchestration(0), default_agent: "agent-b" });
			const codes = async () =>
				(await api.getJson<Preflight>(`/orchestrations/${id}/preflight`)).problems.map(
					(p) => p.code,
				);
			// 别的项目里在线：没有注册过。
			expect(await codes()).toEqual(["agent_not_registered"]);
			// 别的项目里被停用：还是没有注册过，不泄露它在别的项目里被停用了。
			await db.query("update agents set disabled_at = now() where name = 'agent-b'");
			expect(await codes()).toEqual(["agent_not_registered"]);
			// 这个项目里被停用：agent_disabled（上一条用例）。
			await connect("agent-a");
			const own = await api.orchestrationWith(orchestration(0));
			expect((await post("/agents/agent-a/disable")).status).toBe(204);
			expect(
				(await api.getJson<Preflight>(`/orchestrations/${own}/preflight`)).problems.map(
					(p) => p.code,
				),
			).toEqual(["agent_disabled"]);
		} finally {
			await db.end();
		}
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
