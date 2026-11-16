// 切入点 A：动作摘要（规格 #345，#356）。假 Agent 经 gRPC 上报 ActionSummary（action_summary 事件原文），
// 控制面用手动时钟；通过 HTTP（动作摘要接口、运行视图、Agent 列表）和 SSE（运行的事件流）观察。
import { actionsApi, agentsApi, runsApi } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ActionSummaryEvent } from "../src/actions/action-summary.js";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { type AssignedTask, FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { SseClient } from "./support/sse-client.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const DOC = {
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
};

/** 手动时钟的起点（startTestControlPlane 的默认值）。 */
const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
/** 613 天：Agent 时间与控制面时间差得很远时，控制面时间仍按单调时钟读数折算。 */
const DAYS_613 = 613 * 24 * 3600 * 1000;

type Running = ActionSummaryEvent["running"][number];

describe("动作摘要", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	const agents: FakeAgent[] = [];
	const streams: SseClient[] = [];

	const connect = async (name = "agent-a") => {
		const agent = await FakeAgent.connect(cp.grpcUrl, { name }, { clock: cp.clock });
		agents.push(agent);
		return agent;
	};
	const start = async (agent: FakeAgent): Promise<{ runId: string; task: AssignedTask }> => {
		const runId = await api.triggerOk(await api.orchestrationWith(DOC));
		return { runId, task: await agent.nextAssign() };
	};
	const summary = async (taskId: string) => {
		const res = await cp.fetch(`/tasks/${taskId}/actions/summary`);
		expect(res.status).toBe(200);
		return actionsApi.summary.response.parse(await res.json());
	};
	const attemptOf = (view: unknown) =>
		runsApi.get.response.parse(view).chains[0]?.nodes.find((n) => n.node_id === "a")?.attempts[0];
	const runStream = async (runId: string) => {
		const sse = await SseClient.open(cp, `/runs/${runId}/events`);
		streams.push(sse);
		await sse.next("run");
		return sse;
	};
	/** 摘要里一个正在做的动作，开始于控制面时间 `at`（Agent 时间与控制面一致）。 */
	const doing = (
		agent: FakeAgent,
		id: number,
		name: string,
		at: number,
		init: Partial<Running> = {},
	): Running => ({
		id,
		parent: null,
		depth: 0,
		name,
		fields: {},
		...agent.stamp(at),
		...init,
	});

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
	});
	afterEach(async () => {
		for (const s of streams.splice(0)) s.close();
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
	});

	it("摘要接口返回最新的一份：计数、正在做的（带层级）、最近结束的和最近失败的，两种时间都在", async () => {
		const agent = await connect();
		const { task } = await start(agent);
		expect(await summary(task.taskId)).toEqual({
			total: 0,
			marks: 0,
			reported: 0,
			capped: false,
			capped_at: null,
			agent_capped_at: null,
			names: [],
			running: [],
			running_complete: true,
			recent: [],
			recent_failed: [],
		});

		agent.actionSummary(task, { total: 1, reported: 1, names: [] });
		// Agent 时间比控制面快 613 天，单调时钟读数照常：控制面时间按读数折算，Agent 时间原样，耗时是读数之差。
		const skewed = (at: number) => ({ ts: at + DAYS_613, mono: agent.stamp(at).mono });
		const rejected = {
			...doing(agent, 4, "下单", T0 + 2_000, { parent: 1, depth: 1, fields: { 订单: "1002" } }),
			end_ts: T0 + 2_250,
			end_mono: agent.stamp(T0 + 2_250).mono,
			result: "failed" as const,
			reason: "拒单：余额不足",
		};
		agent.actionSummary(task, {
			total: 6,
			marks: 1,
			reported: 4,
			...{ capped_ts: T0 + 3_000, capped_mono: agent.stamp(T0 + 3_000).mono },
			names: [
				{
					name: "保持 4 小时",
					total: 1,
					failed: 0,
					reported: 1,
					capped_ts: null,
					capped_mono: null,
				},
				{
					name: "下单",
					total: 5,
					failed: 1,
					reported: 3,
					...{ capped_ts: T0 + 3_000, capped_mono: agent.stamp(T0 + 3_000).mono },
				},
			],
			running: [
				{ ...doing(agent, 1, "保持 4 小时", T0 + 1_000), ...skewed(T0 + 1_000) },
				doing(agent, 6, "下单", T0 + 4_000, { parent: 1, depth: 1, fields: { 订单: "1004" } }),
			],
			recent: [rejected],
			recent_failed: [rejected],
		});

		await eventually(async () => expect((await summary(task.taskId)).total).toBe(6));
		const failed = {
			id: 4,
			parent: 1,
			depth: 1,
			name: "下单",
			fields: { 订单: "1002" },
			started_at: iso(T0 + 2_000),
			agent_started_at: iso(T0 + 2_000),
			ended_at: iso(T0 + 2_250),
			agent_ended_at: iso(T0 + 2_250),
			duration_ms: 250,
			result: "failed",
			reason: "拒单：余额不足",
		};
		expect(await summary(task.taskId)).toEqual({
			total: 6,
			marks: 1,
			reported: 4,
			capped: true,
			capped_at: iso(T0 + 3_000),
			agent_capped_at: iso(T0 + 3_000),
			names: [
				{
					name: "保持 4 小时",
					total: 1,
					failed: 0,
					reported: 1,
					capped_at: null,
					agent_capped_at: null,
				},
				{
					name: "下单",
					total: 5,
					failed: 1,
					reported: 3,
					capped_at: iso(T0 + 3_000),
					agent_capped_at: iso(T0 + 3_000),
				},
			],
			running: [
				{
					id: 1,
					parent: null,
					depth: 0,
					name: "保持 4 小时",
					fields: {},
					started_at: iso(T0 + 1_000),
					agent_started_at: iso(T0 + 1_000 + DAYS_613),
				},
				{
					id: 6,
					parent: 1,
					depth: 1,
					name: "下单",
					fields: { 订单: "1004" },
					started_at: iso(T0 + 4_000),
					agent_started_at: iso(T0 + 4_000),
				},
			],
			running_complete: true,
			recent: [failed],
			recent_failed: [failed],
		});
	});

	it("运行视图和事件流里的 current_action 是最外层、开始得最早的动作；变了才推送，任务结束后清空", async () => {
		const agent = await connect();
		const { runId, task } = await start(agent);
		const sse = await runStream(runId);
		expect(attemptOf(await api.run(runId))?.current_action).toBeNull();

		// ID 小的不一定开始得早；更深一层的动作开始得再早也不算。
		const order = doing(agent, 2, "下单", T0 + 500, { parent: 3, depth: 1 });
		const running = [
			doing(agent, 1, "连接撮合网关", T0 + 2_000),
			order,
			doing(agent, 3, "保持 4 小时", T0 + 1_000),
		];
		agent.actionSummary(task, { total: 3, reported: 3, running });
		const hold = { name: "保持 4 小时", started_at: iso(T0 + 1_000) };
		expect(attemptOf((await sse.next("run")).data)?.current_action).toEqual(hold);
		expect(attemptOf(await api.run(runId))?.current_action).toEqual(hold);

		// 只有更深一层的动作变了：此刻在做的还是同一个，不重新推送运行视图。
		agent.actionSummary(task, {
			total: 4,
			reported: 4,
			running: [...running, doing(agent, 4, "下单", T0 + 3_000, { parent: 3, depth: 1 })],
		});
		await agent.sync();
		await sse.expectNone(200);

		// 最外层的动作都结束了。
		agent.actionSummary(task, { total: 4, reported: 4, running: [order] });
		expect(attemptOf((await sse.next("run")).data)?.current_action).toBeNull();

		agent.actionSummary(task, {
			total: 5,
			reported: 5,
			running: [doing(agent, 5, "收尾", T0 + 6_000)],
		});
		expect(attemptOf((await sse.next("run")).data)?.current_action).toEqual({
			name: "收尾",
			started_at: iso(T0 + 6_000),
		});

		await agent.succeed(task);
		const ended = attemptOf((await sse.next("run")).data);
		expect(ended?.status).toBe("success");
		expect(ended?.current_action).toBeNull();
		expect(attemptOf(await api.run(runId))?.current_action).toBeNull();
		const kept = await summary(task.taskId);
		expect({ running: kept.running, complete: kept.running_complete, total: kept.total }).toEqual({
			running: [],
			complete: true,
			total: 5,
		});

		// 断线期间结束的任务：Agent 重连后先重发结果，排队的摘要晚于结果到达。计数照收，正在做的仍然为空。
		agent.actionSummary(task, {
			total: 6,
			reported: 6,
			running: [doing(agent, 6, "收尾", T0 + 6_000)],
		});
		await eventually(async () => expect((await summary(task.taskId)).total).toBe(6));
		expect((await summary(task.taskId)).running).toEqual([]);
		expect(attemptOf(await api.run(runId))?.current_action).toBeNull();
	});

	it("失败的任务同样清空正在做的动作，重试的新尝试从头开始", async () => {
		const agent = await connect();
		const runId = await api.triggerOk(
			await api.orchestrationWith({
				...DOC,
				nodes: DOC.nodes.map((n) => (n.id === "a" ? { ...n, retries: 1 } : n)),
			}),
		);
		const first = await agent.nextAssign();
		agent.actionSummary(first, { total: 1, reported: 1, running: [doing(agent, 1, "下单", T0)] });
		await eventually(async () =>
			expect(attemptOf(await api.run(runId))?.current_action?.name).toBe("下单"),
		);

		await agent.fail(first);
		const retry = await agent.nextAssign();
		const view = runsApi.get.response.parse(await api.run(runId));
		const attempts = view.chains[0]?.nodes.find((n) => n.node_id === "a")?.attempts ?? [];
		expect(attempts.map((a) => [a.attempt, a.status, a.current_action])).toEqual([
			[1, "failed", null],
			[2, "running", null],
		]);
		expect((await summary(first.taskId)).running).toEqual([]);
		expect((await summary(retry.taskId)).total).toBe(0);
	});

	it("Agent 列表里正在执行的任务带 current_action", async () => {
		const agent = await connect();
		const { task } = await start(agent);
		const listed = async () => {
			const res = await cp.fetch("/agents");
			const [a] = agentsApi.list.response.parse(await res.json()).agents;
			return a?.running_tasks.map((t) => t.current_action);
		};
		expect(await listed()).toEqual([null]);

		agent.actionSummary(task, {
			total: 1,
			reported: 1,
			running: [doing(agent, 1, "保持 4 小时", T0 + 1_000)],
		});
		await eventually(async () =>
			expect(await listed()).toEqual([{ name: "保持 4 小时", started_at: iso(T0 + 1_000) }]),
		);
		await agent.succeed(task);
		expect(await listed()).toEqual([]);
	});

	it("名称、字段和失败原因里的 secret 值打码", async () => {
		const agent = await connect();
		const { runId, task } = await start(agent);
		const leaked = {
			...doing(agent, 1, "登录 tk-secret", T0, { fields: { 口令: "tk-secret" } }),
			end_ts: T0 + 10,
			end_mono: agent.stamp(T0 + 10).mono,
			result: "failed" as const,
			reason: "认证失败：tk-secret",
		};
		agent.actionSummary(task, {
			total: 2,
			reported: 2,
			names: [
				{
					name: "登录 tk-secret",
					total: 2,
					failed: 1,
					reported: 2,
					capped_ts: null,
					capped_mono: null,
				},
			],
			running: [doing(agent, 2, "登录 tk-secret", T0 + 20, { fields: { 口令: "tk-secret" } })],
			recent: [leaked],
			recent_failed: [leaked],
		});

		await eventually(async () => expect((await summary(task.taskId)).total).toBe(2));
		const body = JSON.stringify(await summary(task.taskId));
		expect(body).not.toContain("tk-secret");
		expect(body).toContain("登录 ******");
		expect(body).toContain("认证失败：******");
		expect(attemptOf(await api.run(runId))?.current_action?.name).toBe("登录 ******");
	});

	it("最长的摘要（几百 KB）整份存下；列满 50 个正在做的动作时写明可能不全", async () => {
		const agent = await connect();
		const { task } = await start(agent);
		const fields = Object.fromEntries(
			Array.from({ length: 8 }, (_, i) => [`字段${i}`, "值".repeat(256)]),
		);
		const name = (i: number, pad: string) => `${String(i).padStart(2, "0")}${pad.repeat(62)}`;
		const ended = Array.from({ length: 25 }, (_, i) => ({
			...doing(agent, i + 1, name(i, "拒"), T0 + i, { fields }),
			end_ts: T0 + i + 1,
			end_mono: agent.stamp(T0 + i + 1).mono,
			result: "failed" as const,
			reason: "因".repeat(4096),
		}));
		const event = {
			total: 75,
			reported: 75,
			names: Array.from({ length: 75 }, (_, i) => ({
				name: name(i, i < 25 ? "拒" : "做"),
				total: 1,
				failed: i < 25 ? 1 : 0,
				reported: 1,
				capped_ts: null,
				capped_mono: null,
			})),
			running: Array.from({ length: 50 }, (_, i) =>
				doing(agent, 26 + i, name(i, "做"), T0 + 100 + i, { fields }),
			),
			recent: ended.slice(5).reverse(),
			recent_failed: ended.slice(20).reverse(),
		};
		expect(Buffer.byteLength(JSON.stringify(event))).toBeGreaterThan(512 * 1024);
		agent.actionSummary(task, event);

		await eventually(async () => expect((await summary(task.taskId)).total).toBe(75));
		const stored = await summary(task.taskId);
		expect([stored.running.length, stored.recent.length, stored.recent_failed.length]).toEqual([
			50, 20, 5,
		]);
		expect(stored.running_complete).toBe(false);
		expect(stored.recent_failed[0]?.reason).toBe("因".repeat(4096));
		expect(stored.running[49]?.fields).toEqual(fields);
	});

	it("别的 Agent 上报的、不是合法摘要的都不改变存下的摘要；任务不存在时 404", async () => {
		const agent = await connect();
		const other = await connect("agent-b");
		const { task } = await start(agent);
		agent.actionSummary(task, { total: 1, reported: 1 });
		await eventually(async () => expect((await summary(task.taskId)).total).toBe(1));

		other.actionSummary(task, { total: 9, reported: 9 });
		agent.send({
			case: "actionSummary",
			value: { taskId: task.taskId, attempt: task.attempt, eventJson: '{"type":"action_summary"}' },
		});
		agent.send({
			case: "actionSummary",
			value: { taskId: task.taskId, attempt: task.attempt, eventJson: "不是 JSON" },
		});
		await Promise.all([other.sync(), agent.sync()]);
		expect((await summary(task.taskId)).total).toBe(1);

		const missing = await cp.fetch("/tasks/00000000-0000-4000-8000-000000000001/actions/summary");
		expect(missing.status).toBe(404);
		expect((await cp.fetch("/tasks/not-a-task/actions/summary")).status).toBe(404);
	});
});
