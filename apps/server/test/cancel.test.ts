// 切入点 A：取消运行（docs/SEMANTICS.md §3.4）——优雅取消、always 节点照常执行、清理中的强制取消。
// HTTP API + 讲真实 gRPC 的假 Agent + 真实 PostgreSQL。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

/** 入口节点 + 若干 stub/echo 包节点串成的单链。 */
function chain(nodes: Array<Record<string, unknown>>): Record<string, unknown> {
	const all: Array<Record<string, unknown>> = [
		{ id: "entry", kind: "entry", params: [] },
		...nodes.map((n) => ({ kind: "package", package: "stub", node: "echo", ...n })),
	];
	return {
		default_agent: "agent-a",
		nodes: all,
		edges: all.slice(1).map((n, i) => ({ from: all[i]?.id, to: n.id, kind: "chain" })),
		packages: { stub: "1.0.0" },
	};
}

describe("取消运行", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let agent: FakeAgent;

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 4 });
	});
	afterEach(async () => {
		await agent.disconnect();
		await cp.close();
	});

	const statuses = async (runId: string) =>
		Object.fromEntries(
			(await api.run(runId)).chains[0]?.nodes.map((n) => [n.node_id, n.status]) ?? [],
		);

	it("普通取消：正在运行的任务收到优雅取消，未开始的普通节点 cancelled，always 节点照常执行，运行最终 cancelled", async () => {
		const id = await api.orchestrationWith(
			chain([{ id: "a" }, { id: "b" }, { id: "c", always: true }, { id: "d" }]),
		);
		const runId = await api.triggerOk(id);
		const a = await agent.nextAssign();

		const view = await api.cancelOk(runId);
		expect(view.status).toBe("running");
		expect(view.cancel).toMatchObject({ requested_by: "tester", forced_at: null });
		expect(await agent.nextCancel()).toMatchObject({
			taskId: a.taskId,
			attempt: a.attempt,
			force: false,
		});
		// 任务被 Agent 终止并上报之前，它仍在运行，always 节点也还没开始。
		expect(await statuses(runId)).toMatchObject({ a: "running", b: "pending", c: "pending" });
		await agent.expectNoAssign();

		await agent.cancelled(a);
		const c = await agent.nextAssign();
		expect(c.nodeId).toBe("c");
		expect(await statuses(runId)).toEqual({
			entry: "success",
			a: "cancelled",
			b: "cancelled",
			c: "running",
			d: "pending",
		});
		expect((await api.run(runId)).status).toBe("running");

		await agent.succeed(c);
		await agent.expectNoAssign();
		const run = await api.run(runId);
		expect(run.status).toBe("cancelled");
		expect(run.ended_at).not.toBeNull();
		expect(run.chains[0]?.status).toBe("cancelled");
		expect(await statuses(runId)).toMatchObject({ c: "success", d: "cancelled" });
		// 被取消的运行中任务算一次尝试；没开始的节点没有尝试记录。
		const aView = await api.node(runId, "a");
		expect(aView.attempts.map((t) => t.status)).toEqual(["cancelled"]);
		expect((await api.node(runId, "b")).attempts).toEqual([]);
	});

	it("还在排队的任务立即取消，不再派发", async () => {
		const offline = await FakeAgent.connect(cp.grpcUrl, { name: "agent-b" });
		await offline.disconnect();
		const id = await api.orchestrationWith(
			chain([{ id: "a", agent: "agent-b" }, { id: "b" }, { id: "c", always: true }]),
		);
		const runId = await api.triggerOk(id);
		expect(await statuses(runId)).toMatchObject({ a: "queued" });

		await api.cancelOk(runId);
		const c = await agent.nextAssign();
		expect(c.nodeId).toBe("c");
		expect(await statuses(runId)).toMatchObject({ a: "cancelled", b: "cancelled", c: "running" });
		expect((await api.node(runId, "a")).attempts).toEqual([]);

		// Agent 上线后也不会收到被取消的任务。
		const back = await FakeAgent.connect(cp.grpcUrl, { name: "agent-b" });
		await back.expectNoAssign();
		await back.disconnect();

		await agent.succeed(c);
		expect((await api.run(runId)).status).toBe("cancelled");
	});

	it("取消时已在执行的 always 节点不受影响，照常完成", async () => {
		const id = await api.orchestrationWith(
			chain([{ id: "a" }, { id: "b" }, { id: "c", always: true }, { id: "d" }]),
		);
		const runId = await api.triggerOk(id);
		await agent.fail(await agent.nextAssign());
		const c = await agent.nextAssign();
		expect(c.nodeId).toBe("c");

		await api.cancelOk(runId);
		await agent.expectNoCancel();
		await agent.succeed(c);
		const run = await api.run(runId);
		expect(run.status).toBe("cancelled");
		expect(await statuses(runId)).toEqual({
			entry: "success",
			a: "failed",
			b: "skipped",
			c: "success",
			d: "cancelled",
		});
	});

	it("取消后任务仍然成功完成时记为成功，后面的普通节点 cancelled", async () => {
		const id = await api.orchestrationWith(
			chain([{ id: "a" }, { id: "b" }, { id: "c", always: true }]),
		);
		const runId = await api.triggerOk(id);
		const a = await agent.nextAssign();
		await api.cancelOk(runId);
		await agent.nextCancel();
		await agent.succeed(a, { v: 1 });
		const c = await agent.nextAssign();
		expect(c.nodeId).toBe("c");
		await agent.succeed(c);
		expect(await statuses(runId)).toMatchObject({ a: "success", b: "cancelled", c: "success" });
		expect((await api.run(runId)).status).toBe("cancelled");
	});

	it("取消后任务失败不再重试，记为 cancelled", async () => {
		const id = await api.orchestrationWith(chain([{ id: "a", retries: 3 }, { id: "b" }]));
		const runId = await api.triggerOk(id);
		const a = await agent.nextAssign();
		await api.cancelOk(runId);
		await agent.nextCancel();
		await agent.fail(a, "killed by SIGTERM");
		await agent.expectNoAssign();
		const aView = await api.node(runId, "a");
		expect(aView.status).toBe("cancelled");
		expect(aView.attempts).toHaveLength(1);
		expect((await api.run(runId)).status).toBe("cancelled");
	});

	it("清理中的强制取消：always 节点也立即终止，后面的 always 节点不再执行，运行立即 cancelled", async () => {
		const id = await api.orchestrationWith(
			chain([{ id: "a" }, { id: "c", always: true }, { id: "d" }, { id: "e", always: true }]),
		);
		const runId = await api.triggerOk(id);
		const a = await agent.nextAssign();
		await api.cancelOk(runId);
		await agent.nextCancel();
		await agent.cancelled(a);
		const c = await agent.nextAssign();
		expect(c.nodeId).toBe("c");

		const view = await api.cancelOk(runId);
		expect(view.status).toBe("cancelled");
		expect(view.cancel?.forced_at).not.toBeNull();
		expect(await agent.nextCancel()).toMatchObject({ taskId: c.taskId, force: true });
		await agent.expectNoAssign();
		expect(await statuses(runId)).toEqual({
			entry: "success",
			a: "cancelled",
			c: "cancelled",
			d: "cancelled",
			e: "cancelled",
		});
		const run = await api.run(runId);
		expect(run.ended_at).not.toBeNull();
		expect(run.chains[0]?.status).toBe("cancelled");

		// Agent 之后上报的结果只确认，不改变状态。
		await agent.cancelled(c);
		expect((await api.node(runId, "c")).status).toBe("cancelled");
	});

	it("优雅终止还没完成时再次取消：强制终止正在运行的任务", async () => {
		const id = await api.orchestrationWith(chain([{ id: "a" }, { id: "c", always: true }]));
		const runId = await api.triggerOk(id);
		const a = await agent.nextAssign();
		await api.cancelOk(runId);
		expect((await agent.nextCancel()).force).toBe(false);
		await api.cancelOk(runId);
		expect(await agent.nextCancel()).toMatchObject({ taskId: a.taskId, force: true });
		await agent.expectNoAssign();
		expect(await statuses(runId)).toMatchObject({ a: "cancelled", c: "cancelled" });
		expect((await api.run(runId)).status).toBe("cancelled");
	});

	it("Agent 断线重连后重新收到取消指令", async () => {
		const id = await api.orchestrationWith(chain([{ id: "a" }]));
		const runId = await api.triggerOk(id);
		const a = await agent.nextAssign();
		await agent.disconnect();
		await api.cancelOk(runId);

		// 重连时在 Hello 中上报手上的任务（#15），控制面继续等它并重发取消指令。
		agent = await FakeAgent.connect(cp.grpcUrl, {
			name: "agent-a",
			slots: 4,
			runningTasks: [{ taskId: a.taskId, attempt: a.attempt }],
		});
		expect(await agent.nextCancel()).toMatchObject({ taskId: a.taskId, force: false });
		await agent.cancelled(a);
		expect((await api.run(runId)).status).toBe("cancelled");
	});

	it("已经结束的运行不能取消；需要昵称；运行不存在为 404", async () => {
		const id = await api.orchestrationWith(chain([{ id: "a" }]));
		const runId = await api.triggerOk(id);
		await agent.succeed(await agent.nextAssign());
		const done = await api.cancel(runId);
		expect(done.status).toBe(409);
		expect(((await done.json()) as { error: { code: string } }).error.code).toBe("run_not_running");

		const anonymous = await cp.fetch(`/runs/${runId}/cancel`, { method: "POST" });
		expect(anonymous.status).toBe(400);
		expect((await api.cancel("00000000-0000-4000-8000-000000000000")).status).toBe(404);
		expect((await api.cancel("nope")).status).toBe(404);
	});
});
