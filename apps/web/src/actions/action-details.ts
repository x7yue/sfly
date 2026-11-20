import type { ActionDetailView, CountOnlyPeriod } from "@sfly/schema";

/**
 * 动作明细的筛选条件和顺序：读取器（task-action-reader.ts）合并分页和推送时、「动作」页签的表格（action-table.ts）
 * 整理三组行时用同一份。
 */

/** 分页的筛选条件（`actionsApi.page` 的 `name`、`failed`）；都不给时是全部。 */
export interface ActionFilter {
	name?: string;
	/** 只看失败的动作（没有标记）。 */
	failed?: boolean;
}

/** 没有筛选。 */
export const NO_FILTER: ActionFilter = {};

/** 名称符不符合筛选条件（没筛选名称时都符合）。 */
export const matchesName = (item: { name: string }, filter: ActionFilter): boolean =>
	filter.name === undefined || item.name === filter.name;

/** 这条明细符不符合筛选条件：实时推送不按筛选条件过滤，推送来的明细要自己挑。 */
export const matchesFilter = (detail: ActionDetailView, filter: ActionFilter): boolean =>
	matchesName(detail, filter) &&
	(!filter.failed || (detail.kind === "action" && detail.result === "failed"));

/**
 * 明细和动作的顺序（与分页相同）：开始时间从新到旧，同一时刻 ID 大的在前。负数表示 a 排在 b 前面。
 * 「动作」页签的三组（action-table.ts）也按它排。
 */
export const byNewest = (a: Started, b: Started): number =>
	Date.parse(b.started_at) - Date.parse(a.started_at) || b.id - a.id;

type Started = Pick<ActionDetailView, "id" | "started_at">;

/**
 * 有序列表里从 `lo` 起第一个让 `before` 不成立的位置（等于长度时在末尾），二分查找：`before` 对前面一段都成立、
 * 对后面一段都不成立。
 */
export function partitionPoint<T>(
	sorted: readonly T[],
	before: (item: T) => boolean,
	lo = 0,
): number {
	let hi = sorted.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (before(sorted[mid] as T)) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** 只计数的段的键：同一个名称、同一种原因至多一段。 */
export const periodKey = (p: CountOnlyPeriod): string => `${p.name}\n${p.reason}`;
