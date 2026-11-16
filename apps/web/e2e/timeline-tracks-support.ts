import type { Locator, Page } from "@playwright/test";
import type { ActionSummaryEvent } from "../../server/src/actions/action-summary.js";
import type { ActionEventInit, AssignedTask } from "../../server/test/support/fake-agent.js";
import type { ManualClock } from "../../server/test/support/manual-clock.js";
import type { TestControlPlane } from "../../server/test/support/test-control-plane.js";
import type { E2eFixtures } from "./fixtures";
import { type Running, runningScenario } from "./monitor-scenario";

// 时间线上的动作轨道（#359）：端到端测试用的动作，比「动作」页的（actions-support.ts）稀，放大以后分得开，
// 而且明细比最新一页（500 条）多，时间线要另读失败的和少见名称的那几页。

/** 「下单」从什么时候起只计数（相对 verify 第 2 次尝试开始，毫秒）。 */
export const CAPPED_AT = 3_500;
/** 只计数以前的「下单」：每 5ms 一个，从第 450ms 起，每 50 个失败一个。 */
const ORDER_AT = (k: number) => 450 + k * 5;
const ORDERS = 610;
const orderFailed = (k: number) => k % 50 === 49;
/** 只计数以后失败、仍有明细的「下单」：ID 和开始的时刻。 */
const LATE_FAILED: [id: number, at: number][] = [
	[1600, 4_000],
	[1601, 4_500],
];
/** 「下单」一共多少个（有明细的、只计数的）。 */
const ORDER_TOTAL = 1_500;
/** 失败的动作一共几个。 */
export const FAILED = Array.from({ length: ORDERS }, (_, k) => k).filter(orderFailed).length + 2;

/**
 * 在 runningScenario 的基础上给 verify 第 2 次尝试（执行中，已经 5 秒）记下动作：最外层先「连接撮合网关」（0–400ms）、
 * 再「预热」（410–2000ms），然后「保持 4 小时」（进行中）；里面每 5ms 一个「下单」（第 450ms 到 3495ms，610 个），
 * 第 3.5 秒起「下单」只计数，之后失败的两个仍有明细；第 3 秒有一次「重连撮合网关」（300ms），第 460ms 有一个标记。
 * 明细 617 条，比时间线读的最新一页（500 条）多。
 */
export async function tracksScenario(
	controlPlane: TestControlPlane,
	connectAgent: E2eFixtures["connectAgent"],
	clock: ManualClock,
): Promise<Running & { verify: AssignedTask; start: number }> {
	const running = await runningScenario(controlPlane, connectAgent, clock);
	const { agent } = running;
	const verify = running.tasks.verify as AssignedTask;
	const now = clock.now().getTime();
	const start = now - 5_000;
	const events: ActionEventInit[] = [
		agent.actionStart(1, "连接撮合网关", start, { fields: { 地址: "10.8.3.21:9001" } }),
		agent.actionEnd(1, "success", start + 400),
		agent.actionStart(2, "预热", start + 410, { fields: { 速率: "200 单/s" } }),
		agent.actionMark(4, "收到第一笔成交", start + 460, { parent: 2 }),
		agent.actionEnd(2, "success", start + 2_000),
		agent.actionStart(3, "保持 4 小时", start + 2_010, { fields: { 目标: "200 单/s" } }),
		agent.actionStart(5, "重连撮合网关", start + 3_002, { parent: 3 }),
		agent.actionEnd(5, "success", start + 3_302),
	];
	for (let k = 0; k < ORDERS; k++) {
		const at = start + ORDER_AT(k);
		const id = 10 + k;
		events.push(
			agent.actionStart(id, "下单", at, { parent: at < start + 2_000 ? 2 : 3 }),
			orderFailed(k)
				? agent.actionEnd(id, "failed", at + 3, { reason: "拒单：价格超出涨跌停" })
				: agent.actionEnd(id, "success", at + 1 + (k % 3)),
		);
	}
	for (const [id, at] of LATE_FAILED) {
		events.push(
			agent.actionStart(id, "下单", start + at, { parent: 3, late: true }),
			agent.actionEnd(id, "failed", start + at + 30, { reason: "超时：200ms 内没有回报" }),
		);
	}
	agent.actions(verify, events);
	agent.actionSummary(verify, summaryOf(agent, start, now));
	await agent.sync();
	return { ...running, verify, start };
}

function summaryOf(
	agent: Running["agent"],
	start: number,
	now: number,
): Partial<ActionSummaryEvent> {
	const one = (name: string) => ({
		name,
		total: 1,
		failed: 0,
		reported: 1,
		capped_ts: null,
		capped_mono: null,
	});
	const capped = agent.stamp(start + CAPPED_AT);
	const names = [
		one("连接撮合网关"),
		one("预热"),
		one("收到第一笔成交"),
		{
			name: "下单",
			total: ORDER_TOTAL,
			failed: FAILED,
			reported: ORDERS + LATE_FAILED.length,
			capped_ts: capped.ts,
			capped_mono: capped.mono,
		},
		one("保持 4 小时"),
		one("重连撮合网关"),
	];
	const recent = Array.from({ length: 20 }, (_, i) => {
		const at = now - 420 + i * 20;
		const end = agent.stamp(at + 4);
		return {
			id: 1980 + i,
			parent: 3,
			depth: 1,
			name: "下单",
			fields: {},
			...agent.stamp(at),
			end_ts: end.ts,
			end_mono: end.mono,
			result: "success" as const,
			reason: null,
		};
	}).reverse();
	const lateFailed = LATE_FAILED.map(([id, at]) => {
		const end = agent.stamp(start + at + 30);
		return {
			id,
			parent: 3,
			depth: 1,
			name: "下单",
			fields: {},
			...agent.stamp(start + at),
			end_ts: end.ts,
			end_mono: end.mono,
			result: "failed" as const,
			reason: "超时：200ms 内没有回报",
		};
	}).reverse();
	return {
		total: names.reduce((n, c) => n + c.total, 0),
		marks: 1,
		reported: names.reduce((n, c) => n + c.reported, 0),
		names,
		running: [
			{
				id: 3,
				parent: null,
				depth: 0,
				name: "保持 4 小时",
				fields: {},
				...agent.stamp(start + 2_010),
			},
			{ id: 2000, parent: 3, depth: 1, name: "下单", fields: {}, ...agent.stamp(now - 2) },
		],
		recent,
		recent_failed: lateFailed,
	};
}

export const timeline = (page: Page): Locator => page.getByRole("region", { name: "链路时间线" });
export const timelineBody = (page: Page): Locator => page.locator("#timeline-body");
/** 一个节点的两条轨道（可访问名称概括轨道的内容）。 */
export const tracksOf = (page: Page, node: string): Locator =>
	timeline(page).locator(`[data-action-tracks="${node}"]`);
export const nodeRow = (page: Page, node: string): Locator =>
	timeline(page).locator(`[data-node-row="${node}"]`);

/**
 * 在时间线的轨道上从 `from` 拖到 `to`（轨道宽度的比例）缩放：拖选的起点要在轨道上，不在标签列。
 */
export async function brush(page: Page, row: Locator, from: number, to: number) {
	const axis = await timeline(page).locator("[data-axis-track]").boundingBox();
	const box = await row.boundingBox();
	if (!axis || !box) throw new Error("没有轨道");
	const y = box.y + box.height / 2;
	await page.mouse.move(axis.x + axis.width * from, y);
	await page.mouse.down();
	await page.mouse.move(axis.x + axis.width * to, y, { steps: 6 });
	await page.mouse.up();
}
