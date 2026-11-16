import type { RunFocusItem } from "@sfly/schema";

/** 节点卡片、Agent 槽位格最多显示属于一个节点的几个关注项（方案 4.2 第 4 条）。 */
export const FOCUS_PREVIEW_LIMIT = 2;

/** 只放得下几项的地方显示哪几项（{@link focusPreview}）。 */
export interface FocusPreview<T> {
	/** 显示的几项，按读数的顺序。 */
	shown: T[];
	/** 没显示的项数：「还有 N 个关注项」。 */
	more: number;
	/** 有异常的项数，含没显示的：「N 项需要注意」。 */
	attention: number;
}

/**
 * 只放得下几项的地方（节点卡片、Agent 槽位格、控制台的运行块）显示哪几项：取前 `limit` 项，其余只计数。
 * `items` 是 `GET /runs/:id/focus` 的读数，或者其中属于一个节点的那些。读数由控制面排好：
 * 有异常的在最前，其余按作者的顺序。这里不再排，所以各处显示的前几项和概览的顺序一致。
 */
export function focusPreview<T extends Pick<RunFocusItem, "anomaly">>(
	items: readonly T[],
	limit = FOCUS_PREVIEW_LIMIT,
): FocusPreview<T> {
	return {
		shown: items.slice(0, limit),
		more: Math.max(0, items.length - limit),
		attention: items.filter((item) => item.anomaly !== null).length,
	};
}
