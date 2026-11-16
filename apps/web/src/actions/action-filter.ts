import type { ActionSummaryView } from "@sfly/schema";
import { ACTION_PAGE } from "#/lib/copy";
import { formatInteger } from "#/lib/format";
import type { ActionFilter } from "./action-details";

/**
 * 「动作」页签的筛选条件（名称、只看失败）怎么变，以及筛选之后读屏播报什么。
 * 要读哪些明细、表格里留哪些行在 `use-task-actions.ts` 和 `action-table.ts`。
 */

export const isFiltered = (filter: ActionFilter): boolean =>
	filter.name !== undefined || filter.failed === true;

/** 换名称：点下拉或名称的个数按钮；点已经选中的名称取消它，`undefined` 是全部名称。 */
export const withName = (filter: ActionFilter, name: string | undefined): ActionFilter =>
	build(filter.name === name ? undefined : name, filter.failed);

export const withFailed = (filter: ActionFilter, failed: boolean): ActionFilter =>
	build(filter.name, failed);

const build = (name: string | undefined, failed: boolean | undefined): ActionFilter => ({
	...(name !== undefined && { name }),
	...(failed && { failed: true }),
});

/** 失败的动作一共有多少个（不论有没有明细）：不给名称是所有名称的合计。 */
export const failedTotal = (summary: ActionSummaryView, name?: string): number =>
	summary.names.reduce(
		(sum, n) => (name === undefined || n.name === name ? sum + n.failed : sum),
		0,
	);

/**
 * 筛选之后读屏播报的话，由摘要里的个数算出（不看已经读到的明细：明细只读了一部分）。只看失败的个数是动作的；
 * 只按名称筛选时，名称的个数动作和标记在一起，任务里有标记就不说成都是动作。
 * 在点的那一刻算一次播报，不要随摘要的更新重算：执行中的任务每秒都有新的摘要，读屏会一直读。
 */
export function filterAnnouncement(summary: ActionSummaryView, filter: ActionFilter): string {
	if (!isFiltered(filter)) return ACTION_PAGE.cleared;
	if (filter.failed) {
		return ACTION_PAGE.result(formatInteger(failedTotal(summary, filter.name)), false);
	}
	const total = summary.names.find((n) => n.name === filter.name)?.total ?? 0;
	return ACTION_PAGE.result(formatInteger(total), summary.marks > 0);
}
