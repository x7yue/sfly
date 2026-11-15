import type { RunFocusItem } from "@sfly/schema";

/** 节点卡片、Agent 槽位格这些放不下全部关注项的地方，每个节点（任务）显示几个。 */
export const TOP_FOCUS_ITEMS = 2;

/**
 * 一个节点（任务）的关注项里要显示的前几个：有异常的排前，其余保持原来的顺序；放不下的个数是 `more`
 * （写成「还有 N 个关注项」，`FOCUS.moreItems`）。
 */
export function topFocusItems<T extends Pick<RunFocusItem, "anomaly">>(
	items: readonly T[],
	max: number = TOP_FOCUS_ITEMS,
): { shown: T[]; more: number } {
	const ordered = [...items.filter((i) => i.anomaly), ...items.filter((i) => !i.anomaly)];
	return { shown: ordered.slice(0, max), more: Math.max(0, ordered.length - max) };
}
