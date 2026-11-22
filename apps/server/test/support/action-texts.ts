// 往一个任务里写一组带文字的动作（#517 的测试用）：一个正在做的最外层动作（名称、字段）、一个失败的子动作（失败原因），
// 还有对应的动作摘要。文字由测试给，例如带着后来才成为 secret 的值，或者跨在截断的上限上。
import type { AssignedTask, FakeAgent } from "./fake-agent.js";

export const ACTION_T0 = Date.parse("2026-01-01T00:00:00.000Z");

/** 动作里会出现用户内容的四处文字。 */
export interface ActionTexts {
	name: string;
	/** 字段的键。 */
	key: string;
	/** 字段的值。 */
	value: string;
	/** 失败的子动作的失败原因。 */
	reason: string;
}

/**
 * 写明细（开始、结束）和摘要（正在做的、最近结束的、最近失败的），等控制面处理完。
 * `agent` 要用 `clock` 选项连接（动作的时间折算用它）。
 */
export async function writeActions(
	agent: FakeAgent,
	task: AssignedTask,
	texts: ActionTexts,
): Promise<void> {
	const t0 = ACTION_T0;
	const fields = { [texts.key]: texts.value };
	agent.actions(task, [
		agent.actionStart(1, texts.name, t0 + 1_000, { fields }),
		agent.actionStart(2, "child", t0 + 2_000, { parent: 1, fields: { note: "plain" } }),
		agent.actionEnd(2, "failed", t0 + 3_000, { reason: texts.reason }),
	]);
	const end = agent.stamp(t0 + 3_000);
	const running = {
		id: 1,
		parent: null,
		depth: 0,
		name: texts.name,
		fields,
		...agent.stamp(t0 + 1_000),
	};
	const child = {
		id: 2,
		parent: 1,
		depth: 1,
		name: "child",
		fields: { note: "plain" },
		...agent.stamp(t0 + 2_000),
		end_ts: end.ts,
		end_mono: end.mono,
		result: "failed" as const,
		reason: texts.reason,
	};
	const zero = { reported: 1, capped_ts: null, capped_mono: null, failed: 0 };
	agent.actionSummary(task, {
		total: 2,
		reported: 2,
		names: [
			{ name: texts.name, total: 1, ...zero },
			{ name: "child", total: 1, ...zero, failed: 1 },
		],
		running: [running],
		recent: [child],
		recent_failed: [child],
	});
	await agent.sync();
}

/** 把一个 secret 值切成「前 `kept` 个字符留在截断处」的样子：`pad` 个填充字符加上整个值，之后由控制面按上限截断。 */
export const straddling = (filler: string, limit: number, value: string, kept: number): string =>
	filler.repeat(limit - kept) + value;

/**
 * 前面完整出现一次 secret 值、结尾又被截在值中间（留下前 `kept` 个字符），整段正好 `limit` 个字符。
 * 写入时这个值还不是 secret：前面的完整出现读取时换成掩码，文字变短、到不了上限，结尾那半截也要盖住。
 */
export const fullThenClipped = (
	filler: string,
	limit: number,
	value: string,
	kept: number,
): string =>
	`${filler}${value}${filler.repeat(limit - filler.length - value.length - kept)}${value.slice(0, kept)}`;
