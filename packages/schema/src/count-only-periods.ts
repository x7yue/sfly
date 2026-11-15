import type { ActionNameCount, CountOnlyPeriod } from "./http/actions.js";

/**
 * SDK 的上限造成的只计数的段（`name_limit`、`total_limit`，docs/ARCHITECTURE.md §6.3「只计数的段」），完全由动作摘要
 * 算出：控制面分页时用它，web 用最新的摘要（推送来的）算，执行中才开始只计数的名称不用重读分页就有。控制面兜底的段
 * （`control_plane`）摘要里没有，只随分页返回。
 *
 * 每种名称一段：从这个名称的 `capped_at` 起，到 `to`（任务的结束时间，还在执行时为 null），个数是 `total − reported`。
 * 原因按这个名称先碰到的上限：合计还没满，或者它的 `capped_at` 早于合计的 `capped_at`，是每种名称的上限，否则是合计的上限。
 * `filter` 与分页的筛选相同：给了名称只要这个名称的；只看失败时，每种名称上限的段只在合计也满了时才有（合计没满时，
 * 超过每种名称上限之后失败的动作仍有明细）。
 */
export function sdkCountOnlyPeriods(
	summary: { names: readonly ActionNameCount[]; capped_at: string | null },
	filter: { name?: string; failed?: boolean },
	to: string | null,
): CountOnlyPeriod[] {
	const totalCapped = summary.capped_at === null ? null : Date.parse(summary.capped_at);
	return summary.names.flatMap((n): CountOnlyPeriod[] => {
		const count = n.total - n.reported;
		if (n.capped_at === null || count <= 0) return [];
		if (filter.name !== undefined && n.name !== filter.name) return [];
		const reason =
			totalCapped === null || Date.parse(n.capped_at) < totalCapped ? "name_limit" : "total_limit";
		if (reason === "name_limit" && filter.failed && totalCapped === null) return [];
		const from = n.capped_at;
		return [{ name: n.name, reason, from, agent_from: n.agent_capped_at ?? from, to, count }];
	});
}
