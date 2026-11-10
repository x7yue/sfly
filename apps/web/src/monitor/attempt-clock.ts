import type { AttemptView, ClockOffsetView } from "@sfly/schema";
import { formatClockOffset } from "#/lib/format";

/** 一次尝试在 Agent 上的开始、结束时间（ADR 0018）：只在时钟偏差达到阈值时才有。 */
export interface AttemptAgentTimes {
	/** 开始、结束时的 Agent 时间（ISO）；那一头没有记录偏差（或时间超出可表示的范围）时为 null。 */
	start: string | null;
	end: string | null;
	/** 两头各差多少，一头一条：`开始时比控制面快 613 天`、`结束时慢 3 秒`。 */
	details: string[];
}

/** 测量那一刻的 Agent 时间：测量时刻（控制面时间）加偏差。Agent 时间可以是任何值，超出 Date 范围时为 null。 */
function agentTime(offset: ClockOffsetView | null): string | null {
	if (!offset) return null;
	const time = new Date(Date.parse(offset.measured_at) + offset.offset_ms);
	return Number.isNaN(time.getTime()) ? null : time.toISOString();
}

/**
 * 尝试开始或结束时的时钟偏差达到阈值（由接口判断）时，给出两头的 Agent 时间和偏差说明；
 * 都不到阈值、或没有记录（旧版本 Agent、旧任务、控制面执行的节点）时返回 null：只显示控制面时间。
 */
export function attemptAgentTimes(
	attempt: Pick<AttemptView, "start_clock_offset" | "end_clock_offset">,
): AttemptAgentTimes | null {
	const ends = [
		["开始", attempt.start_clock_offset],
		["结束", attempt.end_clock_offset],
	] as const;
	if (!ends.some(([, offset]) => offset?.exceeds_threshold)) return null;
	let named = false;
	const parts = ends.flatMap(([label, offset]) => {
		if (!offset) return [];
		if (!offset.exceeds_threshold) return [`${label}时一致`];
		// 「比控制面」只在第一处写。
		const subject = named ? "" : "比控制面";
		named = true;
		return [`${label}时${subject}${formatClockOffset(offset.offset_ms)}`];
	});
	return {
		start: agentTime(attempt.start_clock_offset),
		end: agentTime(attempt.end_clock_offset),
		details: parts,
	};
}
