// 切入点 A：「立即更新」（ADR 0014）。控制面让版本不一致的 Agent 手上的任务以 agent_lost 失败、按重试配置重新排队，
// 并通知 Agent 立即更新；Agent 以一致的版本重新连上后重新派发。
import { AgentUpdateState } from "@sfly/proto";
import { agentsApi } from "@sfly/schema";
import { afterEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const orchestration = (node: Record<string, unknown>) => ({
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry" },
		{ id: "a", kind: "package", package: "stub", node: "echo", ...node },
	],
	edges: [{ from: "entry", to: "a", kind: "chain" }],
	packages: { stub: "1.0.0" },
});

describe("立即更新", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	const agents: FakeAgent[] = [];

	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp?.close();
	});

	const start = async () => {
		cp = await startTestControlPlane({ version: "2.0.0" });
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: [] });
	};

	const connect = async (hello: Parameters<typeof FakeAgent.connect>[1]) => {
		const agent = await FakeAgent.connect(cp.grpcUrl, hello);
		agents.push(agent);
		return agent;
	};

	const updateNow = (name: string) =>
		api.post(`/agents/${encodeURIComponent(name)}/update-now`, {});

	/** 版本一致时把任务派给 agent-a，然后以旧版本带着这些任务重新连上（模拟控制面升级）。 */
	const holding = async (nodes: Record<string, unknown>[]) => {
		const current = await connect({ name: "agent-a", agentVersion: "2.0.0", slots: 4 });
		const runs: string[] = [];
		for (const node of nodes)
			runs.push(await api.triggerOk(await api.orchestrationWith(orchestration(node))));
		const held = [];
		for (const _ of nodes) held.push(await current.nextAssign());
		await current.disconnect();
		const old = await connect({
			name: "agent-a",
			agentVersion: "1.0.0",
			slots: 4,
			runningTasks: held.map((t) => ({ taskId: t.taskId, attempt: t.attempt, started: true })),
		});
		return { old, held, runs };
	};

	it("Agent 收到立即更新指令；手上的任务以 agent_lost 失败并按重试配置重新排队，更新后重新派发", async () => {
		await start();
		const { old, held, runs } = await holding([{ retries: 1 }, {}]);
		const [retried, once] = runs as [string, string];

		const res = await updateNow("agent-a");
		expect(res.status, await res.clone().text()).toBe(200);
		const body = agentsApi.updateNow.response.parse(await res.json());
		expect(body.terminated_tasks.map((t) => t.task_id).sort()).toEqual(
			held.map((t) => t.taskId).sort(),
		);
		await old.next("updateNow");

		// 配置了重试的节点排队等下一次尝试，没有配置的节点失败、运行失败。
		const a = await api.node(retried, "a");
		expect(a.attempts.map((t) => [t.attempt, t.status, t.error?.kind ?? null])).toEqual([
			[1, "failed", "agent_lost"],
			[2, "queued", null],
		]);
		expect((await api.node(once, "a")).error?.kind).toBe("agent_lost");
		expect((await api.run(once)).status).toBe("failed");

		// Agent 按取消流程终止任务后照常上报结果：控制面忽略，但仍回 Ack。
		for (const task of held) await old.cancelled(task);
		expect((await api.node(retried, "a")).attempts.map((t) => t.status)).toEqual([
			"failed",
			"queued",
		]);
		await old.expectNoAssign();

		// 更新到控制面的版本后重新连上：收到第 2 次尝试。
		await old.disconnect();
		const updated = await connect({ name: "agent-a", agentVersion: "2.0.0" });
		const retry = await updated.nextAssign();
		expect(retry).toMatchObject({ runId: retried, nodeId: "a", attempt: 2 });
		await updated.succeed(retry);
		expect((await api.run(retried)).status).toBe("success");
	});

	it("手上没有任务时也通知 Agent", async () => {
		await start();
		const old = await connect({ name: "agent-a", agentVersion: "1.0.0" });
		const res = await updateNow("agent-a");
		expect(res.status).toBe(200);
		expect(agentsApi.updateNow.response.parse(await res.json())).toEqual({ terminated_tasks: [] });
		await old.next("updateNow");
	});

	it("Agent 不存在、离线、版本一致或需要手动升级时拒绝，不终止任务", async () => {
		await start();
		const error = async (res: Response, status: number, code: string) => {
			expect(res.status).toBe(status);
			expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
		};
		await error(await updateNow("nobody"), 404, "not_found");

		const current = await connect({ name: "agent-a", agentVersion: "2.0.0" });
		const run = await api.triggerOk(await api.orchestrationWith(orchestration({})));
		await current.nextAssign();
		await error(await updateNow("agent-a"), 409, "version_matches");
		await current.expectNoCancel();
		expect((await api.node(run, "a")).status).toBe("running");

		const manual = await connect({ name: "agent-m", agentVersion: "1.0.0" });
		manual.send({
			case: "heartbeat",
			value: {
				runningTasks: [],
				update: {
					state: AgentUpdateState.MANUAL_UPGRADE_REQUIRED,
					reason: "已指定 --no-auto-update",
				},
			},
		});
		await manual.sync();
		await error(await updateNow("agent-m"), 409, "manual_upgrade_required");
		await manual.disconnect();
		await eventually(async () => error(await updateNow("agent-m"), 409, "agent_offline"));
		expect(manual.received.some((m) => m.body.case === "updateNow")).toBe(false);
	});
});
