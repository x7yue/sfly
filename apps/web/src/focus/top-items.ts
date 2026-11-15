import type { RunFocusItem } from "@sfly/schema";

/** 放不下全部关注项的地方（Agent 槽位格）每个节点（任务）显示几个。 */
export const TOP_FOCUS_ITEMS = 2;

/**
 * 一个节点（任务）的关注项里要显示的前 {@link TOP_FOCUS_ITEMS} 个：有异常的排前，其余保持原来的顺序（控制面给的读数
 * 已经是这个顺序，这里不依赖调用方传进来的顺序）；放不下的个数是 `more`（写成「还有 N 个关注项」，`FOCUS.moreItems`）。
 */
export function topFocusItems<T extends Pick<RunFocusItem, "anomaly">>(
	items: readonly T[],
): { shown: T[]; more: number } {
	const ordered = [...items.filter((i) => i.anomaly), ...items.filter((i) => !i.anomaly)];
	return {
		shown: ordered.slice(0, TOP_FOCUS_ITEMS),
		more: Math.max(0, ordered.length - TOP_FOCUS_ITEMS),
	};
}
