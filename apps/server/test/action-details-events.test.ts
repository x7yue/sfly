// 切入点 A：动作的实时推送（规格 #345，#357）：`GET /tasks/:id/actions/events` 推送摘要和新写入、刚结束的明细，
// 事件 ID 是修订号，断线后按 Last-Event-ID 接上。假 Agent 经 gRPC 上报，控制面用手动时钟，SSE 客户端观察。
import {
	type ActionChunk,
	type ActionDetailView,
	type ActionSummaryView,
	actionsApi,
} from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { type AssignedTask, FakeAgent } from "./support/fake-agent.js";
import type { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { SseClient, type SseEvent } from "./support/sse-client.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const DOC = {
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry" },
		{ id: "a", kind: "package", package: "stub", node: "echo" },
	],
	edges: [{ from: "entry", to: "a", kind: "chain" }],
	packages: { stub: "1.0.0" },
};

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

type ActionDetail = Extract<ActionDetailView, { kind: "action" }>;

/** 一个动作的明细：没写的项是「最外层、还在做」，Agent 时间与控制面一致。 */
const action = (
	init: Pick<ActionDetail, "id" | "name" | "started_at"> & Partial<ActionDetail>,
): ActionDetail => ({
	kind: "action",
	parent: null,
	depth: 0,
	fields: {},
	agent_started_at: init.started_at,
	result: null,
	ended_at: null,
	agent_ended_at: null,
	duration_ms: null,
	reason: null,
	...init,
});

const EMPTY: ActionSummaryView = {
	total: 0,
	marks: 0,
	reported: 0,
	capped: false,
	control_plane_capped: false,
	capped_at: null,
	agent_capped_at: null,
	names: [],
	running: [],
	running_complete: true,
	recent: [],
	recent_failed: [],
};

describe("动作的实时推送", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let agent: FakeAgent;
	const streams: SseClient[] = [];

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" }, { clock: cp.clock });
	});
	afterEach(async () => {
		for (const s of streams.splice(0)) s.close();
		await agent.disconnect();
		await cp.close();
	});

	const start = async (): Promise<AssignedTask> => {
		await api.triggerOk(await api.orchestrationWith(DOC));
		return agent.nextAssign();
	};
	const open = async (taskId: string, query = "", headers: Record<string, string> = {}) => {
		const sse = await SseClient.open(cp, `/tasks/${taskId}/actions/events${query}`, headers);
		streams.push(sse);
		return sse;
	};
	const summaryOf = (event: SseEvent) =>
		actionsApi.events.events.summary.parse(event.data) as ActionSummaryView;
	const chunkOf = (event: SseEvent) =>
		actionsApi.events.events.actions.parse(event.data) as ActionChunk;
	/** 收到的 actions 事件：ID 和每个事件里的明细 ID。 */
	const actionEvents = (sse: SseClient) =>
		sse.received
			.filter((e) => e.event === "actions")
			.map((e) => [e.id, chunkOf(e).actions.map((a) => a.id)]);

	it("连上先推送一份摘要；之后每写入一批推送一批（事件 ID 是修订号），每存一份摘要推送一份", async () => {
		const task = await start();
		const sse = await open(task.taskId);
		const first = await sse.next("summary");
		expect(summaryOf(first)).toEqual(EMPTY);
		expect(first.id).toBe("0");

		agent.actions(task, [
			agent.actionStart(1, "保持 4 小时", T0 + 1_000),
			agent.actionStart(2, "下单", T0 + 2_000, { parent: 1, fields: { 订单: "1001" } }),
		]);
		const written = await sse.next("actions");
		expect(written.id).toBe("1");
		expect(chunkOf(written)).toEqual({
			actions: [
				action({ id: 1, name: "保持 4 小时", started_at: iso(T0 + 1_000) }),
				action({
					id: 2,
					parent: 1,
					depth: 1,
					name: "下单",
					fields: { 订单: "1001" },
					started_at: iso(T0 + 2_000),
				}),
			],
		});

		agent.actionSummary(task, { total: 2, reported: 2 });
		const summary = await sse.next("summary");
		expect(summaryOf(summary)).toMatchObject({ total: 2, reported: 2 });
		expect(summary.id).toBe("1");

		agent.actions(task, [agent.actionEnd(2, "failed", T0 + 2_500, { reason: "拒单" })]);
		const ended = await sse.next("actions");
		expect(ended.id).toBe("2");
		expect(chunkOf(ended).actions).toEqual([
			action({
				id: 2,
				parent: 1,
				depth: 1,
				name: "下单",
				fields: { 订单: "1001" },
				started_at: iso(T0 + 2_000),
				result: "failed",
				reason: "拒单",
				ended_at: iso(T0 + 2_500),
				agent_ended_at: iso(T0 + 2_500),
				duration_ms: 500,
			}),
		]);
		await agent.sync();
		await sse.expectNone(100);
	});

	it("断线后用 Last-Event-ID（或分页的 rev）接上：不重复、不遗漏，同一个修订号的明细都在一个事件里", async () => {
		const task = await start();
		const ids = (from: number, count: number) => Array.from({ length: count }, (_, k) => from + k);
		// 修订号 1：900 个动作开始；2：900 个标记；3：结束动作 1–5，再加 895 个标记。
		agent.actions(
			task,
			ids(1, 900).map((id) => agent.actionStart(id, "下单", T0 + id)),
		);
		agent.actions(
			task,
			ids(901, 900).map((id) => agent.actionMark(id, "回报", T0 + id)),
		);
		agent.actions(task, [
			...ids(1, 5).map((id) => agent.actionEnd(id, "success", T0 + 5_000 + id)),
			...ids(1801, 895).map((id) => agent.actionMark(id, "回报", T0 + id)),
		]);
		await agent.sync();
		const latest = await (await cp.fetch(`/tasks/${task.taskId}/actions?limit=1`)).json();
		expect(actionsApi.page.response.parse(latest).rev).toBe(3);

		// 读到过修订号 1 的浏览器重连：之后结束的 1–5 跟着修订号 3 再来一次，6–900 不再重发。
		const resumed = await open(task.taskId, "", { "last-event-id": "1" });
		await resumed.next("summary");
		await resumed.next("actions");
		await resumed.next("actions");
		expect(actionEvents(resumed)).toEqual([
			["2", ids(901, 900)],
			["3", [...ids(1, 5), ...ids(1801, 895)]],
		]);
		expect(chunkOf(resumed.received.at(-1) as SseEvent).actions[0]).toMatchObject({
			id: 1,
			result: "success",
		});

		// 分页给的 rev 用作 after；URL 里的 after 和 Last-Event-ID 取较大者。
		const fromPage = await open(task.taskId, "?after=2");
		const both = await open(task.taskId, "?after=1", { "last-event-id": "2" });
		for (const sse of [fromPage, both]) {
			await sse.next("actions");
			expect(actionEvents(sse)).toEqual([["3", [...ids(1, 5), ...ids(1801, 895)]]]);
		}

		// 接上以后照常推送新写入的。
		agent.actions(task, [agent.actionEnd(6, "success", T0 + 6_000)]);
		for (const sse of [resumed, fromPage, both]) {
			const next = await sse.next("actions");
			expect([next.id, chunkOf(next).actions.map((a) => a.id)]).toEqual(["4", [6]]);
		}
		await agent.sync();
		for (const sse of [resumed, fromPage, both]) await sse.expectNone(50);
	});

	it("任务结束时推送一份正在做的为空的摘要和记为未结束的明细；结束以后才连上的也会收到", async () => {
		const task = await start();
		const sse = await open(task.taskId);
		await sse.next("summary");
		agent.actions(task, [agent.actionStart(1, "保持 4 小时", T0 + 1_000)]);
		await sse.next("actions");
		const running = { id: 1, parent: null, depth: 0, name: "保持 4 小时", fields: {} };
		agent.actionSummary(task, {
			total: 1,
			reported: 1,
			running: [{ ...running, ...agent.stamp(T0 + 1_000) }],
		});
		expect(summaryOf(await sse.next("summary")).running).toHaveLength(1);

		(cp.clock as ManualClock).set(iso(T0 + 10_000));
		await agent.succeed(task);
		const unfinished = action({
			id: 1,
			name: "保持 4 小时",
			started_at: iso(T0 + 1_000),
			result: "unfinished",
			ended_at: iso(T0 + 10_000),
			duration_ms: 9_000,
		});
		const ended = await sse.next("summary");
		expect(summaryOf(ended)).toMatchObject({ total: 1, running: [], running_complete: true });
		expect(ended.id).toBe("1");
		const finished = await sse.next("actions");
		expect(chunkOf(finished).actions).toEqual([unfinished]);
		expect(finished.id).toBe("1");

		// 结束以后才连上（已经读到修订号 1）：摘要里正在做的为空，记为未结束的明细再推送一次。
		const late = await open(task.taskId, "", { "last-event-id": "1" });
		expect(summaryOf(await late.next("summary"))).toMatchObject({ total: 1, running: [] });
		expect(chunkOf(await late.next("actions")).actions).toEqual([unfinished]);

		// 之后才到的结束（断线补发）不再写：未结束定格在任务结束的那一刻，修订号不变。
		agent.actions(task, [agent.actionEnd(1, "success", T0 + 9_000)]);
		await agent.sync();
		const res = await cp.fetch(`/tasks/${task.taskId}/actions`);
		expect(await res.json()).toMatchObject({ actions: [unfinished], rev: 1 });
	});

	it("连上时任务还没开始执行：之后开始、结束时同样推送记为未结束的明细", async () => {
		await api.triggerOk(await api.orchestrationWith(DOC));
		const task = await agent.nextAssign({ start: false });
		const sse = await open(task.taskId);
		expect(summaryOf(await sse.next("summary"))).toEqual(EMPTY);

		await agent.started(task);
		agent.actions(task, [agent.actionStart(1, "预热", T0 + 1_000)]);
		await sse.next("actions");
		(cp.clock as ManualClock).set(iso(T0 + 5_000));
		await agent.fail(task);
		expect(summaryOf(await sse.next("summary")).running).toEqual([]);
		expect(chunkOf(await sse.next("actions")).actions).toEqual([
			action({
				id: 1,
				name: "预热",
				started_at: iso(T0 + 1_000),
				result: "unfinished",
				ended_at: iso(T0 + 5_000),
				duration_ms: 4_000,
			}),
		]);
	});

	it("任务不存在时 404", async () => {
		for (const id of ["00000000-0000-4000-8000-000000000001", "not-a-task"]) {
			const res = await cp.fetch(`/tasks/${id}/actions/events`, {
				headers: { accept: "text/event-stream" },
			});
			expect(res.status, id).toBe(404);
		}
	});
});
