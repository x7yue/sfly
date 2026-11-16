// 切入点 A：动作明细（规格 #345，#357）。假 Agent 经 gRPC 上报 ActionBatch（和摘要），控制面用手动时钟；
// 通过 HTTP（明细分页接口、动作摘要、运行视图）观察。
import { type ActionDetailView, type ActionPage, actionsApi } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ActionSummaryEvent } from "../src/actions/action-summary.js";
import { ApiClient } from "./support/api-client.js";
import { type AssignedTask, agentClock, FakeAgent } from "./support/fake-agent.js";
import type { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
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

/** 引号、反斜杠、逗号、花括号：字段值原样存下、原样读出。 */
const RAW = '拒绝 "余额不足", C:\\单\\{1002}';

type Detail = ActionDetailView;
type ActionDetail = Extract<Detail, { kind: "action" }>;
type NameCount = ActionSummaryEvent["names"][number];

/** 一个动作的明细：没写的项是「最外层、还在做」。 */
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

describe("动作明细", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	const agents: FakeAgent[] = [];
	const clock = () => cp.clock as ManualClock;

	const connect = async (name = "agent-a") => {
		const agent = await FakeAgent.connect(cp.grpcUrl, { name }, { clock: cp.clock });
		agents.push(agent);
		return agent;
	};
	const start = async (
		agent: FakeAgent,
		doc: unknown = DOC,
	): Promise<{ runId: string; task: AssignedTask }> => {
		const runId = await api.triggerOk(await api.orchestrationWith(doc));
		return { runId, task: await agent.nextAssign() };
	};
	const pageRes = (taskId: string, query: Record<string, string | number | boolean> = {}) => {
		const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
		return cp.fetch(`/tasks/${taskId}/actions${qs.size ? `?${qs}` : ""}`);
	};
	const page = async (
		taskId: string,
		query: Record<string, string | number | boolean> = {},
	): Promise<ActionPage> => {
		const res = await pageRes(taskId, query);
		expect(res.status).toBe(200);
		return actionsApi.page.response.parse(await res.json());
	};
	/** 一直往前翻，按页返回（每页的明细 ID 和只计数的段）。 */
	const allPages = async (taskId: string, query: Record<string, string | number | boolean>) => {
		const pages: ActionPage[] = [];
		let before: string | null | undefined;
		do {
			const next = await page(taskId, before ? { ...query, before } : query);
			pages.push(next);
			before = next.before;
		} while (before);
		return pages;
	};
	const ids = (p: ActionPage) => p.actions.map((a) => a.id);

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
	});
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
	});

	it("存下动作、子动作和标记：字段按写的先后（之后补充的覆盖同名的）、原样保存，两种时间，耗时；按开始时间从新到旧", async () => {
		const agent = await connect();
		const { task } = await start(agent);
		expect(await page(task.taskId)).toEqual({
			task_id: task.taskId,
			actions: [],
			before: null,
			count_only: [],
			rev: 0,
			expired: false,
		});

		agent.actions(task, [
			agent.actionStart(1, "保持 4 小时", T0 + 1_000),
			agent.actionStart(2, "下单", T0 + 2_000, {
				parent: 1,
				fields: { 订单: "1001", 价格: "10.5", 方向: "买" },
			}),
			agent.actionEnd(2, "success", T0 + 2_250, { fields: { 价格: "10.6", 回报: "成交" } }),
			agent.actionMark(3, "收到第一笔成交", T0 + 2_300, { parent: 1, fields: { 原文: RAW } }),
			agent.actionStart(4, "下单", T0 + 3_000, { parent: 1, fields: { 订单: "1002" } }),
		]);
		// 动作 4 在下一批里结束，带上补充的字段。
		agent.actions(task, [
			agent.actionEnd(4, "failed", T0 + 3_500, {
				reason: "拒单：余额不足",
				fields: { 回报: RAW },
			}),
		]);
		await agent.sync();

		expect(await page(task.taskId)).toEqual({
			task_id: task.taskId,
			actions: [
				action({
					id: 4,
					parent: 1,
					depth: 1,
					name: "下单",
					fields: { 订单: "1002", 回报: RAW },
					started_at: iso(T0 + 3_000),
					ended_at: iso(T0 + 3_500),
					agent_ended_at: iso(T0 + 3_500),
					duration_ms: 500,
					result: "failed",
					reason: "拒单：余额不足",
				}),
				{
					kind: "mark",
					id: 3,
					parent: 1,
					depth: 1,
					name: "收到第一笔成交",
					fields: { 原文: RAW },
					started_at: iso(T0 + 2_300),
					agent_started_at: iso(T0 + 2_300),
				},
				action({
					id: 2,
					parent: 1,
					depth: 1,
					name: "下单",
					fields: { 订单: "1001", 价格: "10.6", 方向: "买", 回报: "成交" },
					started_at: iso(T0 + 2_000),
					ended_at: iso(T0 + 2_250),
					agent_ended_at: iso(T0 + 2_250),
					duration_ms: 250,
					result: "success",
				}),
				action({ id: 1, name: "保持 4 小时", started_at: iso(T0 + 1_000) }),
			],
			before: null,
			count_only: [],
			rev: 2,
			expired: false,
		});
		expect(Object.keys((await page(task.taskId)).actions[2]?.fields ?? {})).toEqual([
			"订单",
			"价格",
			"方向",
			"回报",
		]);
	});

	it("字段的先后和作者写的一致：明细接口和摘要接口都一样（键名长短不一，jsonb 会按长短重排）", async () => {
		const agent = await connect();
		const { task } = await start(agent);
		const written = { 订单号: "P-1", 价: "18.3", 数量: "200", 买卖方向: "卖", 备注: "首单" };
		const order = Object.keys(written);
		agent.actions(task, [
			agent.actionStart(1, "下单", T0 + 1_000, { fields: written }),
			agent.actionStart(2, "下单", T0 + 2_000, { fields: written }),
			agent.actionEnd(2, "success", T0 + 2_100),
		]);
		const entry = (id: number, at: number) => ({
			id,
			parent: null,
			depth: 0,
			name: "下单",
			fields: written,
			...agent.stamp(at),
		});
		agent.actionSummary(task, {
			total: 2,
			reported: 2,
			names: [
				{ name: "下单", total: 2, failed: 0, reported: 2, capped_ts: null, capped_mono: null },
			],
			running: [entry(1, T0 + 1_000)],
			recent: [
				{
					...entry(2, T0 + 2_000),
					...{ end_ts: T0 + 2_100, end_mono: agent.stamp(T0 + 2_100).mono },
					result: "success",
					reason: null,
				},
			],
		});
		await agent.sync();

		const details = (await page(task.taskId)).actions;
		expect(details.map((a) => Object.keys(a.fields))).toEqual([order, order]);
		const res = await cp.fetch(`/tasks/${task.taskId}/actions/summary`);
		const summary = actionsApi.summary.response.parse(await res.json());
		expect(summary.running.map((a) => Object.keys(a.fields))).toEqual([order]);
		expect(summary.recent.map((a) => Object.keys(a.fields))).toEqual([order]);
	});

	it("分页：按开始时间从新到旧（同一时刻 ID 大的在前），游标接着读更早的；按名称、只看失败筛选", async () => {
		const agent = await connect();
		const { task } = await start(agent);
		// 动作 3、4 同一时刻开始；6 是标记。
		agent.actions(task, [
			agent.actionStart(1, "下单", T0 + 1_000),
			agent.actionEnd(1, "failed", T0 + 1_100, { reason: "拒单" }),
			agent.actionStart(2, "撤单", T0 + 2_000),
			agent.actionEnd(2, "success", T0 + 2_100),
			agent.actionStart(3, "下单", T0 + 3_000),
			agent.actionStart(4, "下单", T0 + 3_000),
			agent.actionEnd(4, "failed", T0 + 3_100, { reason: "超时" }),
			agent.actionStart(5, "撤单", T0 + 4_000),
			agent.actionEnd(5, "failed", T0 + 4_100, { reason: "已成交" }),
			agent.actionMark(6, "下单", T0 + 5_000),
			agent.actionStart(7, "下单", T0 + 6_000),
		]);
		await agent.sync();

		const pages = await allPages(task.taskId, { limit: 3 });
		expect(pages.map(ids)).toEqual([[7, 6, 5], [4, 3, 2], [1]]);
		expect(pages.map((p) => p.before === null)).toEqual([false, false, true]);
		expect((await page(task.taskId, { limit: 7 })).before).toBeNull();

		expect((await allPages(task.taskId, { name: "下单", limit: 2 })).map(ids)).toEqual([
			[7, 6],
			[4, 3],
			[1],
		]);
		const failed = await allPages(task.taskId, { failed: true, limit: 2 });
		expect(failed.map(ids)).toEqual([[5, 4], [1]]);
		expect(failed.flatMap((p) => p.actions.map((a) => a.kind === "action" && a.result))).toEqual([
			"failed",
			"failed",
			"failed",
		]);
		expect(
			(await page(task.taskId, { name: "撤单", failed: true })).actions.map((a) => a.id),
		).toEqual([5]);
		expect((await page(task.taskId, { name: "没有这个名称" })).actions).toEqual([]);
	});

	it("游标不是之前返回的 before 时 400；任务不存在时 404", async () => {
		const agent = await connect();
		const { task } = await start(agent);
		for (const before of ["乱写", "a1.2.3", "1.2", "a.1"]) {
			const res = await pageRes(task.taskId, { before });
			expect(res.status, before).toBe(400);
			expect(await res.json(), before).toMatchObject({ error: { code: "invalid_request" } });
		}
		expect((await pageRes("00000000-0000-4000-8000-000000000001")).status).toBe(404);
		expect((await pageRes("not-a-task")).status).toBe(404);
	});

	describe("只计数的段", () => {
		/** 每秒开始一个动作（T0+1s … T0+9s），名称轮流：奇数秒「下单」，偶数秒「撤单」；动作 2、6 失败。 */
		const nineActions = (agent: FakeAgent, task: AssignedTask) => {
			agent.actions(
				task,
				Array.from({ length: 9 }, (_, i) => {
					const id = i + 1;
					const at = T0 + id * 1_000;
					const name = id % 2 === 1 ? "下单" : "撤单";
					return [
						agent.actionStart(id, name, at),
						agent.actionEnd(id, id === 2 || id === 6 ? "failed" : "success", at + 100, {
							reason: id === 2 || id === 6 ? "拒单" : undefined,
						}),
					];
				}).flat(),
			);
		};
		const capped = (
			agent: FakeAgent,
			name: string,
			at: number | null,
			counts: Pick<NameCount, "total" | "failed" | "reported">,
		): NameCount => ({
			name,
			...counts,
			capped_ts: at === null ? null : agent.stamp(at).ts,
			capped_mono: at === null ? null : agent.stamp(at).mono,
		});

		it("每种名称超过上限、合计超过上限的段来自摘要；一直往前翻，每一段正好出现在它的起点所在的那一页", async () => {
			const agent = await connect();
			const { task } = await start(agent);
			nineActions(agent, task);
			// 「下单」从 4.5 秒起超过每种名称的上限，之后有 7 个没有明细；合计从 8 秒起满了，「撤单」从那时起 3 个没有明细。
			agent.actionSummary(task, {
				total: 19,
				reported: 9,
				...{ capped_ts: agent.stamp(T0 + 8_000).ts, capped_mono: agent.stamp(T0 + 8_000).mono },
				names: [
					capped(agent, "下单", T0 + 4_500, { total: 12, failed: 0, reported: 5 }),
					capped(agent, "撤单", T0 + 8_000, { total: 7, failed: 2, reported: 4 }),
				],
			});
			await agent.sync();

			const nameLimit = {
				name: "下单",
				reason: "name_limit",
				from: iso(T0 + 4_500),
				agent_from: iso(T0 + 4_500),
				to: null,
				count: 7,
			};
			const totalLimit = {
				name: "撤单",
				reason: "total_limit",
				from: iso(T0 + 8_000),
				agent_from: iso(T0 + 8_000),
				to: null,
				count: 3,
			};
			// 每页 2 个：[9, 8] 的范围是 8 秒起（含）到现在，[7, 6] 是 6 秒到 8 秒（不含），[5, 4] 是 4 秒到 6 秒。
			const pages = await allPages(task.taskId, { limit: 2 });
			expect(pages.map(ids)).toEqual([[9, 8], [7, 6], [5, 4], [3, 2], [1]]);
			expect(pages.map((p) => p.count_only)).toEqual([[totalLimit], [], [nameLimit], [], []]);
			// 只有一页时（读到了开头），所有的段都在这一页，从新到旧。
			expect((await page(task.taskId)).count_only).toEqual([totalLimit, nameLimit]);

			// 按名称：只有这个名称的段。
			expect(
				(await allPages(task.taskId, { name: "下单", limit: 1 })).flatMap((p) => p.count_only),
			).toEqual([nameLimit]);
			expect((await page(task.taskId, { name: "撤单" })).count_only).toEqual([totalLimit]);
			// 只看失败：合计也满了，超过每种名称上限之后失败的动作也可能没有明细，两段都在。
			expect((await page(task.taskId, { failed: true })).count_only).toEqual([
				totalLimit,
				nameLimit,
			]);

			// 任务结束以后，段的终点是任务的结束时间。
			clock().set(iso(T0 + 20_000));
			await agent.succeed(task);
			expect((await page(task.taskId)).count_only).toEqual([
				{ ...totalLimit, to: iso(T0 + 20_000) },
				{ ...nameLimit, to: iso(T0 + 20_000) },
			]);
		});

		it("合计没满时，只看失败不返回每种名称超过上限的段（那之后失败的动作都有明细）", async () => {
			const agent = await connect();
			const { task } = await start(agent);
			nineActions(agent, task);
			agent.actionSummary(task, {
				total: 16,
				reported: 9,
				names: [
					capped(agent, "下单", T0 + 4_500, { total: 12, failed: 0, reported: 5 }),
					capped(agent, "撤单", null, { total: 4, failed: 2, reported: 4 }),
				],
			});
			await agent.sync();

			const nameLimit = {
				name: "下单",
				reason: "name_limit",
				from: iso(T0 + 4_500),
				agent_from: iso(T0 + 4_500),
				to: null,
				count: 7,
			};
			expect((await page(task.taskId)).count_only).toEqual([nameLimit]);
			expect((await page(task.taskId, { failed: true })).count_only).toEqual([]);
			expect((await page(task.taskId, { name: "撤单" })).count_only).toEqual([]);
		});
	});

	describe("任务结束时没结束的动作", () => {
		/** 开始两个动作：1 在第 1 秒开始、没有结束；2 在第 2 秒开始、第 3 秒结束。 */
		const twoActions = (agent: FakeAgent, task: AssignedTask) => {
			agent.actions(task, [
				agent.actionStart(1, "保持 4 小时", T0 + 1_000),
				agent.actionStart(2, "下单", T0 + 2_000, { parent: 1 }),
				agent.actionEnd(2, "success", T0 + 3_000),
			]);
			return agent.sync();
		};
		/** 动作 1 记为未结束：结束时间取任务的结束时间。 */
		const unfinished = (endedAt: number, agentEndedAt: number | null) =>
			action({
				id: 1,
				name: "保持 4 小时",
				started_at: iso(T0 + 1_000),
				result: "unfinished",
				ended_at: iso(endedAt),
				agent_ended_at: agentEndedAt === null ? null : iso(agentEndedAt),
				duration_ms: endedAt - (T0 + 1_000),
			});
		const ended2 = action({
			id: 2,
			parent: 1,
			depth: 1,
			name: "下单",
			started_at: iso(T0 + 2_000),
			result: "success",
			ended_at: iso(T0 + 3_000),
			agent_ended_at: iso(T0 + 3_000),
			duration_ms: 1_000,
		});
		/** 这台 Agent 此刻的时钟读数，Agent 时间比控制面快 offsetMs。 */
		const skewed = (agent: FakeAgent, offsetMs: number) => {
			const now = clock().now().getTime();
			return agentClock(now + offsetMs, Number(agent.monotonicAt(now)));
		};

		it("任务成功：记为未结束，Agent 结束时间按结束时的时钟偏差折算；之后才到的结束照样记下真实的结果", async () => {
			const agent = await connect();
			const { task } = await start(agent);
			await twoActions(agent, task);
			expect((await page(task.taskId)).actions[1]).toMatchObject({ id: 1, result: null });

			clock().set(iso(T0 + 10_000));
			await agent.succeed(task, {}, skewed(agent, 7_000));
			expect((await page(task.taskId)).actions).toEqual([
				ended2,
				unfinished(T0 + 10_000, T0 + 17_000),
			]);

			// 断线期间结束的任务：结束晚于结果到达。
			agent.actions(task, [agent.actionEnd(1, "failed", T0 + 9_000, { reason: "撤单失败" })]);
			await agent.sync();
			expect((await page(task.taskId)).actions[1]).toEqual(
				action({
					id: 1,
					name: "保持 4 小时",
					started_at: iso(T0 + 1_000),
					result: "failed",
					reason: "撤单失败",
					ended_at: iso(T0 + 9_000),
					agent_ended_at: iso(T0 + 9_000),
					duration_ms: 8_000,
				}),
			);
		});

		it("任务失败、被取消：同样记为未结束；没有上报时钟读数时 Agent 结束时间为空", async () => {
			const agent = await connect();
			const failed = await start(agent);
			await twoActions(agent, failed.task);
			clock().set(iso(T0 + 10_000));
			await agent.fail(failed.task);
			expect((await page(failed.task.taskId)).actions).toEqual([
				ended2,
				unfinished(T0 + 10_000, null),
			]);

			const cancelled = await start(agent);
			await twoActions(agent, cancelled.task);
			clock().set(iso(T0 + 20_000));
			await api.cancelOk(cancelled.runId);
			await agent.nextCancel();
			await agent.cancelled(cancelled.task, "任务已取消", skewed(agent, -3_000));
			expect((await page(cancelled.task.taskId)).actions).toEqual([
				ended2,
				unfinished(T0 + 20_000, T0 + 17_000),
			]);
			expect((await page(cancelled.task.taskId, { failed: true })).actions).toEqual([]);
		});

		it("agent_lost：记为未结束（Agent 结束时间按开始时的时钟偏差折算），重试的新尝试有自己的明细", async () => {
			const agent = await connect();
			const runId = await api.triggerOk(
				await api.orchestrationWith({
					...DOC,
					nodes: DOC.nodes.map((n) => (n.id === "a" ? { ...n, retries: 1 } : n)),
				}),
			);
			const first = await agent.nextAssign({ start: false });
			await agent.started(first, skewed(agent, 5_000));
			await twoActions(agent, first);

			// 连续两次心跳都没有带上这个任务：以 agent_lost 失败，重试派回同一个 Agent。
			clock().set(iso(T0 + 10_000));
			await agent.heartbeat([]);
			await agent.heartbeat([]);
			const retry = await agent.nextAssign();
			expect((await api.node(runId, "a")).attempts.map((t) => [t.attempt, t.error?.kind])).toEqual([
				[1, "agent_lost"],
				[2, undefined],
			]);
			expect((await page(first.taskId)).actions).toEqual([
				ended2,
				unfinished(T0 + 10_000, T0 + 15_000),
			]);

			expect((await page(retry.taskId)).actions).toEqual([]);
			agent.actions(retry, [agent.actionStart(1, "保持 4 小时", T0 + 11_000)]);
			await agent.sync();
			expect((await page(retry.taskId)).actions).toEqual([
				action({ id: 1, name: "保持 4 小时", started_at: iso(T0 + 11_000) }),
			]);
			expect((await page(first.taskId)).actions).toHaveLength(2);
		});
	});

	it("时间：控制面时间按单调时钟读数折算、Agent 时间原样；Agent 时间在动作中途跳变时耗时不受影响", async () => {
		const agent = await connect();
		const { task } = await start(agent);
		const at = (cpMs: number, agentMs: number) => ({ ...agent.stamp(cpMs), ts: agentMs });
		agent.actions(task, [
			// Agent 时间比控制面快 613 天。
			agent.actionStart(1, "保持 4 小时", at(T0 + 1_000, T0 + 1_000 + DAYS_613)),
			agent.actionMark(2, "开盘", at(T0 + 1_500, T0 + 1_500 + DAYS_613)),
			agent.actionStart(3, "下单", T0 + 2_000),
		]);
		// 动作进行中，有人把 Agent 的系统时间往回改了一天：1、3 在之前的批次里开始，4 在同一批里开始和结束。
		agent.actions(task, [
			agent.actionEnd(1, "success", at(T0 + 61_000, T0 + 61_000 - 86_400_000)),
			agent.actionEnd(3, "success", at(T0 + 2_400, T0 + 2_400 - 86_400_000)),
			agent.actionStart(4, "撤单", T0 + 3_000),
			agent.actionEnd(4, "success", at(T0 + 3_300, T0 + 3_300 - 86_400_000)),
		]);
		await agent.sync();

		expect((await page(task.taskId)).actions).toEqual([
			action({
				id: 4,
				name: "撤单",
				started_at: iso(T0 + 3_000),
				result: "success",
				ended_at: iso(T0 + 3_300),
				agent_ended_at: iso(T0 + 3_300 - 86_400_000),
				duration_ms: 300,
			}),
			action({
				id: 3,
				name: "下单",
				started_at: iso(T0 + 2_000),
				result: "success",
				ended_at: iso(T0 + 2_400),
				agent_ended_at: iso(T0 + 2_400 - 86_400_000),
				duration_ms: 400,
			}),
			{
				kind: "mark",
				id: 2,
				parent: null,
				depth: 0,
				name: "开盘",
				fields: {},
				started_at: iso(T0 + 1_500),
				agent_started_at: iso(T0 + 1_500 + DAYS_613),
			},
			action({
				id: 1,
				name: "保持 4 小时",
				started_at: iso(T0 + 1_000),
				agent_started_at: iso(T0 + 1_000 + DAYS_613),
				result: "success",
				ended_at: iso(T0 + 61_000),
				agent_ended_at: iso(T0 + 61_000 - 86_400_000),
				duration_ms: 60_000,
			}),
		]);
	});

	it("同一个 ID 的重复明细被忽略；别的 Agent 上报的明细不存；名称、字段值和失败原因里的 secret 值打码", async () => {
		const agent = await connect();
		const other = await connect("agent-b");
		const { task } = await start(agent);
		agent.actions(task, [
			agent.actionStart(1, "登录 tk-secret", T0 + 1_000, { fields: { 口令: "tk-secret" } }),
			agent.actionEnd(1, "failed", T0 + 1_200, { reason: "认证失败：tk-secret" }),
			agent.actionStart(1, "重复的", T0 + 1_300),
		]);
		agent.actions(task, [agent.actionStart(1, "又一个重复的", T0 + 1_400)]);
		other.actions(task, [other.actionStart(2, "别的 Agent", T0 + 1_500)]);
		await Promise.all([agent.sync(), other.sync()]);

		const { actions } = await page(task.taskId);
		expect(actions).toEqual([
			action({
				id: 1,
				name: "登录 ******",
				fields: { 口令: "******" },
				started_at: iso(T0 + 1_000),
				result: "failed",
				reason: "认证失败：******",
				ended_at: iso(T0 + 1_200),
				agent_ended_at: iso(T0 + 1_200),
				duration_ms: 200,
			}),
		]);
		expect(JSON.stringify(actions)).not.toContain("tk-secret");
	});
});
