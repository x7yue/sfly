import type { Locator, Page } from "@playwright/test";
import type { ActionSummaryEvent } from "../../server/src/actions/action-summary.js";
import type {
	ActionEventInit,
	AssignedTask,
	FakeAgent,
} from "../../server/test/support/fake-agent.js";
import type { ManualClock } from "../../server/test/support/manual-clock.js";
import type { TestControlPlane } from "../../server/test/support/test-control-plane.js";
import type { E2eFixtures } from "./fixtures";
import { type Running, runningScenario } from "./monitor-scenario";

// 运行监控「动作」页（#357）：端到端测试与视觉回归共用的动作和标记。

type Ended = ActionSummaryEvent["recent"][number];
type NameCount = ActionSummaryEvent["names"][number];

/** 「下单」从什么时候起只计数（相对 verify 第 2 次尝试开始，毫秒）。 */
const CAPPED_AT = 1_500;
/** 「下单」一共多少个，有明细的、只计数的都算。 */
const ORDERS = 1_200;
/** 只计数之前的「下单」，都有明细：每 3ms 一个，每 80 个失败一个。 */
const PRE_CAP = Array.from({ length: 400 }, (_, i) => i + 3);
const preCapFailed = (id: number) => id % 80 === 0;
/** 只计数以后失败、所以仍有明细的「下单」：ID 和开始的时刻（相对尝试开始）。 */
const LATE_FAILED: [id: number, at: number][] = [
	[1100, 2_000],
	[1150, 3_000],
	[1180, 4_200],
];
/** 最近结束的 20 个（只计数以后的「下单」，摘要里一直有）；其中 1190 失败，所以也有明细。 */
const RECENT = Array.from({ length: 20 }, (_, i) => 1181 + i);
const RECENT_FAILED = 1190;
const RECENT_REASON = "超时：撮合网关 3 秒没有回报";
const LATE_REASON =
	"拒单：余额不足（可用 1,203.55，需要 9,800.00）；撮合网关返回 REJECT_BALANCE，这一笔不再重试，等下一轮行情";

const orderFields = (id: number) => ({
	订单: `P-${String(id).padStart(4, "0")}`,
	方向: id % 2 ? "卖" : "买",
});
/** 最近 20 个里第 id 个开始的时刻。 */
const recentAt = (now: number, id: number) => now - 400 + (id - 1181) * 18;

/** verify 第 2 次尝试开始的时刻和此刻（控制面时间，毫秒）。 */
export interface ActionClock {
	start: number;
	now: number;
}

/**
 * 在 runningScenario 的基础上给 verify 第 2 次尝试（执行中，已经 5 秒）记下动作：
 *
 * - 「保持 4 小时」（最外层，进行中）里每 3ms 一个「下单」，ID 3–402 有明细（每 80 个失败一个）；第 1.5 秒起
 *   「下单」超过每种名称的上限、只计数，之后失败的 1100、1150、1180 仍有明细；开头有一个标记「收到第一笔成交」（ID 2）；
 * - 正在做的：「保持 4 小时」和最里面的四层子动作（最深的「读取缓存」在第 4 层，画在第 3 层）；
 * - 最近 20 个是只计数以后结束的「下单」1181–1200，其中 1190 失败、也有明细。
 *
 * 明细一共 406 条（超过两页），「更早的明细」从新到旧是 1180、1150、1100、只计数的一段、402 … 3、标记 2。
 */
export async function actionsScenario(
	controlPlane: TestControlPlane,
	connectAgent: E2eFixtures["connectAgent"],
	clock: ManualClock,
): Promise<Running & { verify: AssignedTask; times: ActionClock }> {
	const running = await runningScenario(controlPlane, connectAgent, clock);
	const { agent } = running;
	const verify = running.tasks.verify as AssignedTask;
	const now = clock.now().getTime();
	const times = { start: now - 5_000, now };
	const { start } = times;
	const events: ActionEventInit[] = [
		agent.actionStart(1, "保持 4 小时", start, { fields: { 目标: "200 单/s" } }),
		agent.actionMark(2, "收到第一笔成交", start + 5, { parent: 1, fields: { 订单: "P-0003" } }),
	];
	for (const id of PRE_CAP) {
		const at = start + 10 + (id - 3) * 3;
		events.push(agent.actionStart(id, "下单", at, { parent: 1, fields: orderFields(id) }));
		events.push(
			preCapFailed(id)
				? agent.actionEnd(id, "failed", at + 9, { reason: "拒单：余额不足" })
				: agent.actionEnd(id, "success", at + 4 + (id % 5)),
		);
	}
	const late: [number, number, string][] = [
		...LATE_FAILED.map(([id, at]): [number, number, string] => [id, start + at, LATE_REASON]),
		[RECENT_FAILED, recentAt(now, RECENT_FAILED), RECENT_REASON],
	];
	for (const [id, at, reason] of late) events.push(...lateFailure(agent, id, at, reason));
	agent.actions(verify, events);
	agent.actionSummary(verify, actionsSummary(agent, times));
	await agent.sync();
	return { ...running, verify, times };
}

/** 只计数以后失败的一个「下单」：补发的开始（`late`），紧接着结束。 */
export function lateFailure(
	agent: FakeAgent,
	id: number,
	at: number,
	reason: string,
): [ActionEventInit, ActionEventInit] {
	return [
		agent.actionStart(id, "下单", at, { parent: 1, late: true, fields: orderFields(id) }),
		agent.actionEnd(id, "failed", at + 30, { reason }),
	];
}

/** 推送的用例在打开页面以后记下的动作：一次「重连撮合网关」。 */
export const RECONNECT = { id: 1171, name: "重连撮合网关", at: 3_500, took: 300 } as const;

/**
 * actionsScenario 的摘要：计数、正在做的、最近 20 个都和上报的明细对得上。`reconnected`：推送的用例之后又记下的
 * 「重连撮合网关」（{@link RECONNECT}）已经结束。
 */
export function actionsSummary(
	agent: FakeAgent,
	{ start, now }: ActionClock,
	reconnected = false,
): Partial<ActionSummaryEvent> {
	const at = (ms: number) => agent.stamp(ms);
	const count = (name: string, total = 1, failed = 0, reported = total): NameCount => ({
		name,
		total,
		failed,
		reported,
		capped_ts: null,
		capped_mono: null,
	});
	const orderFailed = PRE_CAP.filter(preCapFailed).length + LATE_FAILED.length + 1;
	const orderReported = PRE_CAP.length + LATE_FAILED.length + 1;
	const capped = at(start + CAPPED_AT);
	const names: NameCount[] = [
		count("保持 4 小时"),
		count("收到第一笔成交"),
		{
			...count("下单", ORDERS, orderFailed, orderReported),
			capped_ts: capped.ts,
			capped_mono: capped.mono,
		},
		count("风控检查"),
		count("查询额度"),
		count("读取缓存"),
		...(reconnected ? [count(RECONNECT.name)] : []),
	];
	const runningAt = (
		id: number,
		name: string,
		parent: number | null,
		depth: number,
		from: number,
	) => ({
		id,
		parent,
		depth,
		name,
		fields: {},
		...at(from),
	});
	const recent = RECENT.map((id): Ended => {
		const failed = id === RECENT_FAILED;
		const begin = at(recentAt(now, id));
		const end = at(recentAt(now, id) + (failed ? 30 : 6));
		return {
			id,
			parent: 1,
			depth: 1,
			name: "下单",
			fields: orderFields(id),
			...begin,
			end_ts: end.ts,
			end_mono: end.mono,
			result: failed ? "failed" : "success",
			reason: failed ? RECENT_REASON : null,
		};
	}).reverse();
	const total = names.reduce((n, c) => n + c.total, 0);
	return {
		total,
		marks: 1,
		reported: names.reduce((n, c) => n + c.reported, 0),
		names,
		running: [
			{ ...runningAt(1, "保持 4 小时", null, 0, start), fields: { 目标: "200 单/s" } },
			{ ...runningAt(1201, "下单", 1, 1, now - 12), fields: orderFields(1201) },
			runningAt(1202, "风控检查", 1201, 2, now - 9),
			runningAt(1203, "查询额度", 1202, 3, now - 6),
			runningAt(1204, "读取缓存", 1203, 4, now - 3),
		],
		recent,
		recent_failed: recent.filter((a) => a.result === "failed"),
	};
}

/** 「动作」页的表格（滚动容器）。 */
export const actionTable = (page: Page): Locator => page.getByTestId("action-table");

/** 一组（`running` / `recent` / `earlier`）里现在渲染出来的行：动作和标记写 ID，只计数的段写 `~名称`。 */
export function groupRows(table: Locator, group: string): Promise<string[]> {
	const body = `tbody[data-group="${group}"]`;
	return table
		.locator(`${body} tr[data-action-id], ${body} tr[data-count-only]`)
		.evaluateAll((rows) =>
			rows.map((r) => {
				const { countOnly, actionId } = (r as HTMLElement).dataset;
				return countOnly !== undefined ? `~${countOnly}` : String(actionId);
			}),
		);
}
