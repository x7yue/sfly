// 切入点 A：动作明细的控制面兜底上限（规格 #345，#357）。被改过的 SDK 写出超过上限的明细时，控制面每个任务最多存 10 万条、
// 每种名称最多 5 万条（补发的失败动作只算进合计），超出的丢弃，在任务日志里写一行警告。经 HTTP 观察。
import { type ActionPage, actionsApi, logsApi } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { type ActionEventInit, FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
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
/** Agent 一批最多 1000 个事件。 */
const BATCH = 1000;

describe("动作明细的控制面兜底上限", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let agent: FakeAgent;

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" }, { clock: cp.clock });
	});
	afterEach(async () => {
		await agent.disconnect();
		await cp.close();
	});

	const page = async (taskId: string, query: Record<string, string | number | boolean> = {}) => {
		const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
		const res = await cp.fetch(`/tasks/${taskId}/actions?${qs}`);
		expect(res.status).toBe(200);
		return actionsApi.page.response.parse(await res.json()) as ActionPage;
	};

	/** n 个字符（都在基本平面内，一个字符就是一个 UTF-16 码元）。 */
	const chars = (n: number) => "长".repeat(n);

	it("名称、字段值、失败原因超过 SDK 的上限时按同样的上限截断：名称 64、字段值 256、原因 4096 个字符；字段的键按名称的上限截断", async () => {
		await api.triggerOk(await api.orchestrationWith(DOC));
		const task = await agent.nextAssign();
		agent.actions(task, [
			agent.actionStart(1, chars(100), T0 + 1_000, {
				fields: { 订单: chars(300), [chars(5_000)]: "键很长" },
			}),
			agent.actionEnd(1, "failed", T0 + 2_000, { reason: chars(5_000) }),
			agent.actionMark(2, chars(65), T0 + 3_000),
		]);
		await agent.sync();

		const [mark, ended] = (await page(task.taskId)).actions;
		expect(mark?.name).toBe(chars(64));
		expect(ended?.fields).toEqual({ 订单: chars(256), [chars(64)]: "键很长" });
		expect(ended?.name).toBe(chars(64));
		expect(ended?.kind === "action" && ended.reason).toBe(`${chars(4_095)}…`);
	});

	it("摘要也按同样的上限截断（字段最多 8 个），名称最多列 1000 种：被改过的 SDK 每秒写一份很大的摘要也写不爆数据库", async () => {
		await api.triggerOk(await api.orchestrationWith(DOC));
		const task = await agent.nextAssign();
		const stamp = agent.stamp(T0 + 1_000);
		const ended = {
			id: 2,
			parent: null,
			depth: 0,
			name: chars(80),
			fields: { 订单: chars(300) },
			...stamp,
			end_ts: stamp.ts + 10,
			end_mono: stamp.mono + 10,
			result: "failed" as const,
			reason: chars(5_000),
		};
		agent.actionSummary(task, {
			total: 1_200,
			reported: 1_200,
			names: Array.from({ length: 1_200 }, (_, i) => ({
				name: `${chars(70)}${i}`,
				total: 1,
				failed: 0,
				reported: 1,
				capped_ts: null,
				capped_mono: null,
			})),
			running: [
				{
					id: 1,
					parent: null,
					depth: 0,
					name: chars(90),
					fields: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, "v"])),
					...stamp,
				},
			],
			recent: [ended],
			recent_failed: [ended],
		});
		await agent.sync();

		const res = await cp.fetch(`/tasks/${task.taskId}/actions/summary`);
		const summary = actionsApi.summary.response.parse(await res.json());
		expect(summary.names).toHaveLength(1_000);
		expect(summary.names[0]?.name).toBe(chars(64));
		expect(summary.running[0]?.name).toBe(chars(64));
		expect(Object.keys(summary.running[0]?.fields ?? {})).toHaveLength(8);
		expect(summary.recent_failed[0]).toMatchObject({
			name: chars(64),
			fields: { 订单: chars(256) },
			reason: `${chars(4_095)}…`,
		});
		expect(summary.recent[0]?.reason).toBe(`${chars(4_095)}…`);
	});

	it("每个任务最多 10 万条、每种名称最多 5 万条，补发的失败动作只算进合计；超出的丢弃，任务日志里只写一行警告", async () => {
		await api.triggerOk(await api.orchestrationWith(DOC));
		const task = await agent.nextAssign();
		const send = (events: ActionEventInit[]) => {
			for (let i = 0; i < events.length; i += BATCH)
				agent.actions(task, events.slice(i, i + BATCH));
		};
		/** `count` 个标记，ID 从 `firstId` 起，第 k 个在 `from + k` 毫秒。 */
		const marks = (name: string, firstId: number, count: number, from: number) =>
			Array.from({ length: count }, (_, k) => agent.actionMark(firstId + k, name, from + k));

		const summary = async () =>
			actionsApi.summary.response.parse(
				await (await cp.fetch(`/tasks/${task.taskId}/actions/summary`)).json(),
			);
		expect((await summary()).control_plane_capped).toBe(false);

		// 「下单」存满 5 万条，再来的标记和普通的开始都被丢弃；补发的失败动作照常存下。
		send(marks("下单", 1, 50_000, T0 + 1));
		send([
			...marks("下单", 50_001, 5, T0 + 60_001),
			agent.actionStart(50_006, "下单", T0 + 30_000, { late: true }),
			agent.actionEnd(50_006, "failed", T0 + 60_006, { reason: "拒单" }),
			agent.actionStart(50_007, "下单", T0 + 60_010),
			agent.actionEnd(50_007, "failed", T0 + 60_020, { reason: "拒单" }),
		]);
		// 「撤单」把合计存满 10 万条，之后的都被丢弃，补发的失败动作和新的名称也一样。
		send(marks("撤单", 50_008, 49_999, T0 + 100_000));
		send(marks("撤单", 100_007, 3, T0 + 200_001));
		send([
			agent.actionStart(100_010, "撤单", T0 + 150_000, { late: true }),
			agent.actionEnd(100_010, "failed", T0 + 200_010, { reason: "已成交" }),
			agent.actionMark(100_011, "开盘", T0 + 200_020),
		]);
		// 10 万条明细分 100 批写库：整套测试一起跑时要 4 到 7 秒，默认的 5 秒等不够。
		await agent.sync({ timeoutMs: 15_000 });

		expect((await page(task.taskId, { limit: 1 })).actions.map((a) => a.id)).toEqual([100_006]);
		expect((await page(task.taskId, { name: "下单", limit: 1 })).actions.map((a) => a.id)).toEqual([
			50_000,
		]);
		const failed = await page(task.taskId, { failed: true });
		expect(failed.actions.map((a) => [a.id, a.name])).toEqual([[50_006, "下单"]]);

		const dropped = (name: string, from: number, count: number) => ({
			name,
			reason: "control_plane",
			from: iso(from),
			agent_from: iso(from),
			to: null,
			count,
		});
		expect((await page(task.taskId, { name: "下单" })).count_only).toEqual([
			dropped("下单", T0 + 60_001, 6),
		]);
		// 段的起点是被丢弃的明细里最早的开始：后一批里补发的失败动作开始得更早。
		expect((await page(task.taskId, { name: "撤单" })).count_only).toEqual([
			dropped("撤单", T0 + 150_000, 4),
		]);
		expect((await page(task.taskId, { name: "开盘" })).count_only).toEqual([
			dropped("开盘", T0 + 200_020, 1),
		]);

		const logs = logsApi.page.response.parse(
			await (await cp.fetch(`/tasks/${task.taskId}/logs`)).json(),
		);
		const warnings = logs.lines.filter((l) => l.source === "system");
		expect(warnings.map((l) => l.level)).toEqual(["warn"]);
		expect(warnings[0]?.text).toContain("100000");
		expect(warnings[0]?.text).toContain("50000");
		expect(warnings[0]?.text).toContain("不再保存");
		// 摘要写明控制面丢弃过明细（SDK 的摘要里没有超出上限，检查器靠它说明哪些只计数）。
		expect(await summary()).toMatchObject({ capped: false, control_plane_capped: true });
	}, 60_000);
});
