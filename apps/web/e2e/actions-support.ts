import type { ActionSummaryEvent } from "../../server/src/actions/action-summary.js";
import type { FakeAgent } from "../../server/test/support/fake-agent.js";

// 画布检查器里「正在做」和「动作」的端到端测试与视觉回归共用的摘要。

type Summary = Partial<Omit<ActionSummaryEvent, "type">>;

/** 失败原因的上限是 4096 个字符（SDK 截断）：一整段没有空格的长文，对版面最不留情。 */
export const LONG_REASON = `ConnectionError: ${"abcdefghij".repeat(500)}`.slice(0, 4096);

/** 一个失败的下单。 */
export interface Reject {
	/** 开始的时刻：多少毫秒之前。 */
	ago: number;
	order: string;
	reason: string;
	/** 耗时（毫秒）。 */
	took: number;
}

/** 最近的五个失败，最近的在前：长的原因放在中间，多行的原因放在最后。 */
export const REJECTS: readonly Reject[] = [
	{
		ago: 31_000,
		order: "P-1284808",
		reason: "拒单：价格超出涨跌停（报价 18.17，下限 18.20）",
		took: 3,
	},
	{ ago: 5 * 60_000, order: "P-1230734", reason: "拒单：可用资金不足", took: 6 },
	{ ago: 9 * 60_000, order: "P-1184694", reason: LONG_REASON, took: 5 },
	{
		ago: 13 * 60_000,
		order: "P-1134681",
		reason: "拒单：价格超出涨跌停（报价 18.62，上限 18.40）",
		took: 5,
	},
	{
		ago: 17 * 60_000,
		order: "P-1085996",
		reason: "TimeoutError: 200ms 内没有回报\n  at gateway.wait (gateway.py:88)",
		took: 200,
	},
];

/**
 * `load`（下单压测）一小时 43 分钟时的摘要（设计原型的演示数据）：「保持 4 小时」里每下一单记一个「下单」，
 * 「下单」超过每种名称的上限（84 分钟之前）后只计数，合计还没满；正在做的有三层。`now` 是控制面时间（毫秒）。
 */
export function loadSummary(agent: FakeAgent, now: number): Summary {
	const at = (ago: number) => agent.stamp(now - ago);
	const failed = (reject: Reject, id: number) => ({
		id,
		parent: 1,
		depth: 1,
		name: "下单",
		fields: { 订单: reject.order, 方向: "买" },
		...at(reject.ago),
		end_ts: at(reject.ago - reject.took).ts,
		end_mono: at(reject.ago - reject.took).mono,
		result: "failed" as const,
		reason: reject.reason,
	});
	const capped = { capped_ts: at(84 * 60_000).ts, capped_mono: at(84 * 60_000).mono };
	return {
		total: 1_284_823,
		reported: 50_021,
		names: [
			{
				name: "连接撮合网关",
				total: 1,
				failed: 0,
				reported: 1,
				capped_ts: null,
				capped_mono: null,
			},
			{ name: "保持 4 小时", total: 1, failed: 0, reported: 1, capped_ts: null, capped_mono: null },
			{ name: "下单", total: 1_284_819, failed: 17, reported: 50_017, ...capped },
			{ name: "首笔成交", total: 2, failed: 0, reported: 2, capped_ts: null, capped_mono: null },
		],
		running: [
			{
				id: 1,
				parent: null,
				depth: 0,
				name: "保持 4 小时",
				fields: { 目标: "200 单/s" },
				...at(103 * 60_000),
			},
			{
				id: 90,
				parent: 1,
				depth: 1,
				name: "下单",
				fields: { 订单: "P-1284814", 方向: "买", 数量: "300", 价格: "18.36" },
				...at(3),
			},
			{ id: 91, parent: 90, depth: 2, name: "等回报", fields: {}, ...at(2) },
		],
		recent_failed: REJECTS.map((reject, i) => failed(reject, 20 + i)),
	};
}
