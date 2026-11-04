// 切入点 A：Agent 断线、排队超时与控制面重启恢复（docs/SEMANTICS.md §3.3、ARCHITECTURE §6.1）。
// HTTP API + 讲真实 gRPC 的假 Agent + 真实 PostgreSQL；时间只由手动时钟推进，不做真实等待。
import { TaskAction } from "@sfly/proto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient, type RunView } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { type AssignedTask, FakeAgent } from "./support/fake-agent.js";
import { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
/** 控制面默认的任务租约：30 秒（Agent 每 10 秒心跳一次）。 */
const LEASE = 30 * SECOND;

type Node = Record<string, unknown> & { id: string };

/** 由若干条链组成的编排（第一个节点是起点）；没写 kind 的是 stub/echo 包节点。 */
function orchestration(chains: Node[][], dispatch: Array<[string, string]> = []) {
	const nodes = chains.map((c) =>
		c.map((n) => (n.kind ? n : { kind: "package", package: "stub", node: "echo", ...n })),
	);
	return {
		default_agent: "agent-a",
		nodes: nodes.flat(),
		edges: [
			...nodes.flatMap((c) =>
				c.slice(1).map((n, i) => ({ from: c[i]?.id, to: n.id, kind: "chain" })),
			),
			...dispatch.map(([from, to]) => ({ from, to, kind: "dispatch" })),
		],
		packages: { stub: "1.0.0" },
	};
}

/** 入口节点 + 若干节点串成的单链。 */
const chain = (nodes: Node[]) =>
	orchestration([[{ id: "entry", kind: "entry", params: [] }, ...nodes]]);

const statuses = (run: RunView, chainIndex = 0) =>
	Object.fromEntries(run.chains[chainIndex]?.nodes.map((n) => [n.node_id, n.status]) ?? []);

describe("Agent 断线、排队超时与重启恢复", () => {
	let cp: TestControlPlane;
	let clock: ManualClock;
	let api: ApiClient;
	const agents: FakeAgent[] = [];

	beforeEach(async () => {
		clock = new ManualClock();
		cp = await startTestControlPlane({ clock });
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
	});
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
	});

	const connect = async (
		name: string,
		extra: { slots?: number; running?: AssignedTask[] } = {},
	) => {
		const agent = await FakeAgent.connect(cp.grpcUrl, {
			name,
			slots: extra.slots ?? 4,
			runningTasks: (extra.running ?? []).map((t) => ({ taskId: t.taskId, attempt: t.attempt })),
		});
		agents.push(agent);
		return agent;
	};
	const disconnect = async (agent: FakeAgent) => {
		agents.splice(agents.indexOf(agent), 1);
		await agent.disconnect();
	};
	const statusesOf = async (runId: string) => statuses(await api.run(runId));

	describe("租约与断线重试", () => {
		it("心跳为运行中的任务续约；Agent 断线后租约过期，任务以 agent_lost 失败并派回同一个 Agent", async () => {
			const agent = await connect("agent-a");
			const id = await api.orchestrationWith(chain([{ id: "a", retries: 1 }, { id: "b" }]));
			const runId = await api.triggerOk(id);
			const first = await agent.nextAssign();

			// 有心跳时，运行超过一个租约也不会过期。
			clock.advance(LEASE - SECOND);
			await agent.heartbeat();
			clock.advance(LEASE - SECOND);
			await agent.heartbeat();
			await agent.expectNoAssign(150);
			expect(await statusesOf(runId)).toMatchObject({ a: "running" });

			await disconnect(agent);
			clock.advance(LEASE - SECOND);
			await new Promise((r) => setTimeout(r, 150));
			expect(await statusesOf(runId)).toMatchObject({ a: "running" });

			clock.advance(SECOND);
			await eventually(async () => {
				const a = await api.node(runId, "a");
				expect(a.attempts.map((t) => [t.attempt, t.status, t.error?.kind])).toEqual([
					[1, "failed", "agent_lost"],
					[2, "queued", undefined],
				]);
				expect(a.attempts[1]?.agent).toBe("agent-a");
			});

			const back = await connect("agent-a");
			const retry = await back.nextAssign();
			expect(retry).toMatchObject({ nodeId: "a", attempt: 2 });
			expect(retry.taskId).not.toBe(first.taskId);
			await back.succeed(retry);
			expect((await back.nextAssign()).nodeId).toBe("b");
		});

		it("重试用尽后 agent_lost 是最终失败：普通节点跳过，always 节点照常执行", async () => {
			const agent = await connect("agent-a");
			const id = await api.orchestrationWith(
				chain([{ id: "a" }, { id: "b" }, { id: "c", always: true }]),
			);
			const runId = await api.triggerOk(id);
			await agent.nextAssign();
			await disconnect(agent);

			clock.advance(LEASE);
			await eventually(async () =>
				expect(await statusesOf(runId)).toMatchObject({
					a: "failed",
					b: "skipped",
					c: "queued",
				}),
			);
			const back = await connect("agent-a");
			await back.succeed(await back.nextAssign());
			const run = await api.run(runId);
			expect(run.status).toBe("failed");
			expect((await api.node(runId, "a")).error?.kind).toBe("agent_lost");
		});

		it("Agent 离线时优雅取消的任务在租约过期后记为 cancelled，always 节点继续执行", async () => {
			const agent = await connect("agent-a");
			const id = await api.orchestrationWith(
				chain([{ id: "a", retries: 3 }, { id: "b" }, { id: "c", always: true }]),
			);
			const runId = await api.triggerOk(id);
			await agent.nextAssign();
			await disconnect(agent);
			await api.cancelOk(runId);

			clock.advance(LEASE);
			await eventually(async () =>
				expect(await statusesOf(runId)).toMatchObject({
					a: "cancelled",
					b: "cancelled",
					c: "queued",
				}),
			);
			const back = await connect("agent-a");
			const c = await back.nextAssign();
			expect(c.nodeId).toBe("c");
			await back.succeed(c);
			expect((await api.run(runId)).status).toBe("cancelled");
		});
	});

	describe("重连后的处置", () => {
		it("Welcome 告诉 Agent 心跳间隔（租约的三分之一）", async () => {
			const agent = await connect("agent-a");
			expect(agent.welcome.heartbeatIntervalMs).toBe(LEASE / 3);
			expect(agent.welcome.dispositions).toEqual([]);
		});

		it("Hello 上报的运行中任务：控制面仍在等的继续，结果照常生效；不认识的放弃", async () => {
			const agent = await connect("agent-a");
			const id = await api.orchestrationWith(chain([{ id: "a" }, { id: "b" }]));
			const runId = await api.triggerOk(id);
			const a = await agent.nextAssign();
			await disconnect(agent);

			const unknown = { ...a, taskId: "11111111-1111-4111-8111-111111111111" };
			const stale = { ...a, attempt: 7 };
			const back = await connect("agent-a", { running: [a, unknown, stale] });
			expect(back.welcome.dispositions).toHaveLength(3);
			expect(back.dispositions[unknown.taskId]).toBe("abandon");
			expect(
				back.welcome.dispositions
					.filter((d) => d.taskId === a.taskId)
					.map((d) => [d.attempt, d.action]),
			).toEqual([
				[1, TaskAction.CONTINUE],
				[7, TaskAction.ABANDON],
			]);
			expect(await statusesOf(runId)).toMatchObject({ a: "running" });

			// 重连续约了租约：从重连时起一个租约内都不会过期。
			clock.advance(LEASE - SECOND);
			await back.succeed(a);
			expect((await back.nextAssign()).nodeId).toBe("b");
			expect((await api.node(runId, "a")).attempts).toHaveLength(1);
		});

		it("控制面认为在运行、但 Hello 里没有的任务立即以 agent_lost 失败并重试（例如 Agent 重启过）", async () => {
			const agent = await connect("agent-a");
			const id = await api.orchestrationWith(chain([{ id: "a", retries: 1 }]));
			const runId = await api.triggerOk(id);
			await agent.nextAssign();
			await disconnect(agent);

			const back = await connect("agent-a");
			const retry = await back.nextAssign();
			expect(retry).toMatchObject({ nodeId: "a", attempt: 2 });
			const a = await api.node(runId, "a");
			expect(a.attempts[0]).toMatchObject({ status: "failed", error: { kind: "agent_lost" } });
			await back.succeed(retry);
			expect((await api.run(runId)).status).toBe("success");
		});

		it("租约过期并已重试后才重连：旧尝试放弃，它后来的结果被忽略，新尝试照常派发", async () => {
			const agent = await connect("agent-a");
			const id = await api.orchestrationWith(chain([{ id: "a", retries: 1 }, { id: "b" }]));
			const runId = await api.triggerOk(id);
			const old = await agent.nextAssign();
			await disconnect(agent);
			clock.advance(LEASE);
			await eventually(async () =>
				expect((await api.node(runId, "a")).attempts.map((t) => t.status)).toEqual([
					"failed",
					"queued",
				]),
			);

			const back = await connect("agent-a", { running: [old] });
			expect(back.dispositions).toEqual({ [old.taskId]: "abandon" });
			const retry = await back.nextAssign();
			expect(retry.attempt).toBe(2);
			await back.succeed(old, { v: "stale" });
			await back.expectNoAssign();
			await back.succeed(retry, { v: "fresh" });
			expect((await back.nextAssign()).nodeId).toBe("b");
			expect((await api.node(runId, "a")).outputs).toEqual({ v: "fresh" });
		});
	});

	describe("控制面重启恢复", () => {
		/** 模拟控制面崩溃重启：Agent 的连接断开，控制面在同一个数据库上重新启动。 */
		const restart = async (downtimeMs = 0) => {
			await Promise.all(agents.splice(0).map((a) => a.disconnect()));
			await cp.restart(() => clock.advance(downtimeMs));
		};

		it("运行中的任务：停机再久也给 Agent 一个租约的时间重连，重连后继续，结果照常推进链", async () => {
			const agent = await connect("agent-a");
			const id = await api.orchestrationWith(chain([{ id: "a" }, { id: "b" }]));
			const runId = await api.triggerOk(id);
			const a = await agent.nextAssign();
			// 停机期间时间走过了租约。
			await restart(5 * MINUTE);
			await new Promise((r) => setTimeout(r, 150));
			expect(await statusesOf(runId)).toMatchObject({ a: "running" });

			const back = await connect("agent-a", { running: [a] });
			expect(back.dispositions).toEqual({ [a.taskId]: "continue" });
			await back.succeed(a, { v: 1 });
			const b = await back.nextAssign();
			expect(b.nodeId).toBe("b");
			await back.succeed(b);
			expect((await api.run(runId)).status).toBe("success");
		});

		it("运行中的任务：Agent 重启后不在线，重启后一个租约内没回来就是 agent_lost", async () => {
			const agent = await connect("agent-a");
			const id = await api.orchestrationWith(chain([{ id: "a" }]));
			const runId = await api.triggerOk(id);
			await agent.nextAssign();
			await restart();
			clock.advance(LEASE);
			await eventually(async () => expect((await api.run(runId)).status).toBe("failed"));
			expect((await api.node(runId, "a")).error?.kind).toBe("agent_lost");
		});

		it("排队中的任务：重启后 Agent 上线就派发", async () => {
			await disconnect(await connect("agent-b"));
			const id = await api.orchestrationWith(chain([{ id: "a", agent: "agent-b" }]));
			const runId = await api.triggerOk(id);
			await restart();
			expect(await statusesOf(runId)).toMatchObject({ a: "queued" });

			const b = await connect("agent-b");
			const a = await b.nextAssign();
			expect(a.nodeId).toBe("a");
			await b.succeed(a);
			expect((await api.run(runId)).status).toBe("success");
		});

		it("等待中的定时节点：重启后继续等待，到点触发", async () => {
			await connect("agent-a");
			// 时钟起点 2026-01-01T00:00:00Z = 上海 08:00。
			const id = await api.orchestrationWith(
				chain([{ id: "t", kind: "timer", at: "09:30:00" }, { id: "a" }]),
			);
			const runId = await api.triggerOk(id);
			expect(await statusesOf(runId)).toMatchObject({ t: "waiting" });
			await restart();
			const back = await connect("agent-a");
			clock.advance(90 * MINUTE - SECOND);
			await back.expectNoAssign(150);
			clock.advance(SECOND);
			const a = await back.nextAssign();
			expect(a.nodeId).toBe("a");
			expect((await api.node(runId, "t")).outputs).toEqual({
				triggered_at: "2026-01-01T01:30:00.000Z",
				late: false,
			});
		});

		it("子流程实例和任务不会因为重启而重复创建", async () => {
			const agent = await connect("agent-a");
			const id = await api.orchestrationWith(
				orchestration(
					[
						[{ id: "entry", kind: "entry", params: [] }, { id: "s", kind: "async" }, { id: "m" }],
						[{ id: "sub", kind: "subflow_entry", params: [] }, { id: "x" }, { id: "y" }],
					],
					[["s", "sub"]],
				),
			);
			const runId = await api.triggerOk(id);
			const first = [await agent.nextAssign(), await agent.nextAssign()];
			expect(first.map((t) => t.nodeId).sort()).toEqual(["m", "x"]);
			const before = await api.run(runId);
			expect(before.chains).toHaveLength(2);

			await restart();
			const back = await connect("agent-a", { running: first });
			await back.expectNoAssign();
			for (const task of first) await back.succeed(task);
			const y = await back.nextAssign();
			expect(y.nodeId).toBe("y");
			await back.succeed(y);
			await back.expectNoAssign();

			const run = await api.run(runId);
			expect(run.status).toBe("success");
			expect(run.chains.map((c) => c.id)).toEqual(before.chains.map((c) => c.id));
			for (const c of run.chains) {
				for (const n of c.nodes) expect(n.attempts, `${c.chain_id}/${n.node_id}`).toHaveLength(1);
			}
			expect(statuses(run, 1)).toEqual({ sub: "success", x: "success", y: "success" });
		});

		it("结果重复上报是幂等的：重启前已处理的结果重报只回 Ack，不会再次推进链", async () => {
			const agent = await connect("agent-a");
			const id = await api.orchestrationWith(chain([{ id: "a" }, { id: "b" }, { id: "c" }]));
			const runId = await api.triggerOk(id);
			const a = await agent.nextAssign();
			await agent.succeed(a, { v: "first" });
			const b = await agent.nextAssign();
			await restart();

			// Agent 没收到 a 的 Ack（例如控制面在发送 Ack 前崩溃），重连后把 a 和 b 都报为手上的任务。
			const back = await connect("agent-a", { running: [a, b] });
			expect(back.dispositions).toEqual({ [a.taskId]: "abandon", [b.taskId]: "continue" });
			await back.succeed(a, { v: "again" });
			await back.succeed(a, { v: "again" });
			await back.expectNoAssign();
			await back.succeed(b);
			await back.succeed(b);
			const c = await back.nextAssign();
			expect(c.nodeId).toBe("c");
			await back.expectNoAssign();
			await back.succeed(c);

			const run = await api.run(runId);
			expect(run.status).toBe("success");
			expect((await api.node(runId, "a")).outputs).toEqual({ v: "first" });
			for (const n of run.chains[0]?.nodes ?? []) expect(n.attempts).toHaveLength(1);
		});
	});

	describe("排队超时", () => {
		it("目标 Agent 不在线时任务保持 queued，超过 queue_timeout 后以 env_error 失败且不重试", async () => {
			await disconnect(await connect("agent-b"));
			const always = await connect("agent-a");
			const id = await api.orchestrationWith(
				chain([
					{ id: "a", agent: "agent-b", queue_timeout: 120, retries: 2 },
					{ id: "b" },
					{ id: "c", always: true },
				]),
			);
			const runId = await api.triggerOk(id);

			clock.advance(2 * MINUTE - SECOND);
			await always.expectNoAssign(150);
			expect(await statusesOf(runId)).toMatchObject({ a: "queued" });

			clock.advance(SECOND);
			const c = await always.nextAssign();
			expect(c.nodeId).toBe("c");
			const a = await api.node(runId, "a");
			expect(a.status).toBe("failed");
			expect(a.error?.kind).toBe("env_error");
			expect(a.error?.message).toContain("agent-b");
			expect(a.attempts).toHaveLength(1);
			expect(await statusesOf(runId)).toMatchObject({ b: "skipped", c: "running" });

			// Agent 之后上线也不会收到这个任务。
			const late = await connect("agent-b");
			await late.expectNoAssign();
			await always.succeed(c);
			expect((await api.run(runId)).status).toBe("failed");
		});

		it("默认排队超时是 10 分钟", async () => {
			await disconnect(await connect("agent-a"));
			const id = await api.orchestrationWith(chain([{ id: "a" }]));
			const runId = await api.triggerOk(id);
			clock.advance(10 * MINUTE - SECOND);
			await new Promise((r) => setTimeout(r, 150));
			expect(await statusesOf(runId)).toMatchObject({ a: "queued" });
			clock.advance(SECOND);
			await eventually(async () => expect((await api.run(runId)).status).toBe("failed"));
			expect((await api.node(runId, "a")).error?.kind).toBe("env_error");
		});

		it("Agent 在线但没有空闲槽位时同样排队，超时后 env_error；重试的尝试从重新排队时计时", async () => {
			const agent = await connect("agent-a", { slots: 1 });
			const busyId = await api.orchestrationWith(chain([{ id: "busy" }]));
			const waitId = await api.orchestrationWith(chain([{ id: "w", queue_timeout: 20 }]));
			const busyRun = await api.triggerOk(busyId);
			const busy = await agent.nextAssign();
			const waitRun = await api.triggerOk(waitId);
			expect(await statusesOf(waitRun)).toMatchObject({ w: "queued" });

			clock.advance(20 * SECOND);
			await eventually(async () => expect((await api.run(waitRun)).status).toBe("failed"));
			expect((await api.node(waitRun, "w")).error?.kind).toBe("env_error");
			expect(await statusesOf(busyRun)).toMatchObject({ busy: "running" });
			await agent.expectNoAssign();
			await agent.succeed(busy);

			// 重试：attempt 2 在失败时重新排队，排队超时从那时开始算。
			const retryId = await api.orchestrationWith(
				chain([{ id: "r", retries: 1, queue_timeout: 20 }]),
			);
			const retryRun = await api.triggerOk(retryId);
			const first = await agent.nextAssign();
			const blocker = await api.triggerOk(busyId);
			clock.advance(15 * SECOND);
			await agent.fail(first);
			const blocking = await agent.nextAssign();
			expect(blocking.runId).toBe(blocker);
			clock.advance(15 * SECOND);
			await agent.heartbeat();
			await new Promise((r) => setTimeout(r, 150));
			expect((await api.node(retryRun, "r")).attempts.map((t) => t.status)).toEqual([
				"failed",
				"queued",
			]);
			clock.advance(5 * SECOND);
			await eventually(async () => expect((await api.run(retryRun)).status).toBe("failed"));
			expect((await api.node(retryRun, "r")).error?.kind).toBe("env_error");
		});
	});
});
