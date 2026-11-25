import { formatDuration } from "#/lib/format";
import type { NodeTiming } from "./timeline-model";

/**
 * 节点的用时在运行监控里怎么写（时间线的节点行、选中节点的摘要、「节点耗时 Top 10」说的是同一个数，各处写明是什么）：
 * 总耗时 = 各次尝试从排队到结束的合计（含排队和等待，不含尝试之间的间隔；一次尝试时和轨道上画的条一样长）；
 * 排队和执行是它的构成，单次尝试的执行写在「尝试」页签的卡片里。
 */
export const NODE_TOTAL_LABEL = "总耗时";
export const NODE_TOTAL_HINT = "各次尝试从排队到结束的合计，含排队和等待，不含尝试之间的间隔";

/**
 * 总耗时后面的构成（选中节点的摘要里）：一次尝试写「排队 2.0s · 执行 4.0s」，多次尝试写「共 2 次尝试 · 排队合计 0.5s · 最近一次执行 5.0s」。
 * 只有执行、没有排队的单次尝试，构成和总耗时是同一个数，不写（null）。
 */
export function timingNote(t: NodeTiming): string | null {
	if (t.total === null) return null;
	const parts: string[] = [];
	if (t.attempts > 1) parts.push(`共 ${t.attempts} 次尝试`);
	if (t.queued > 0)
		parts.push(`${t.attempts > 1 ? "排队合计" : "排队"} ${formatDuration(t.queued)}`);
	if (t.execution !== null && (t.attempts > 1 || t.queued > 0)) {
		parts.push(`${t.attempts > 1 ? "最近一次执行" : "执行"} ${formatDuration(t.execution)}`);
	}
	return parts.length === 0 ? null : parts.join(" · ");
}

/** 时间线节点行上总耗时的提示和读屏名称：「总耗时 6.0s（排队 2.0s · 执行 4.0s）」。 */
export function timingTitle(t: NodeTiming): string | undefined {
	if (t.total === null) return undefined;
	const note = timingNote(t);
	return `${NODE_TOTAL_LABEL} ${formatDuration(t.total)}${note ? `（${note}）` : ""}：${NODE_TOTAL_HINT}`;
}
