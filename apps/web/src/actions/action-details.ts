import type { ActionDetailView, ActionPage, CountOnlyPeriod } from "@sfly/schema";

/**
 * 一个任务（一次尝试）已经读到的动作明细：分页读到的加上实时推送来的（`use-task-actions.ts` 持有它）。
 *
 * 明细最多 10 万条，每秒可能推送好几批，所以只用一个有序数组：位置按二分查找，一批合并只复制一次数组。
 * 同一个 ID 的开始时间不会变（控制面写下开始时就定了，之后只补上结束），所以按开始时间和 ID 找到的就是它原来的位置。
 */
export interface ActionDetails {
	/** 按开始时间从新到旧（同一时刻 ID 大的在前，与分页的顺序相同），同一个 ID 只有一条，后到的为准。 */
	readonly details: readonly ActionDetailView[];
	/**
	 * 分页读到的控制面兜底的只计数的段（`control_plane`），同一个名称只有一段（后读到的为准），按起点从新到旧。
	 * SDK 上限的段不从分页取，由最新的摘要算出（action-table.ts）。
	 */
	readonly controlPlanePeriods: readonly CountOnlyPeriod[];
	/** 读更早一页的游标；null：已经读到最早的明细。 */
	readonly before: string | null;
	/** 最新一页的修订号：实时推送从它之后接上。 */
	readonly rev: number;
	/** 运行已超过保留期，明细已被清理。 */
	readonly expired: boolean;
}

/** 分页的筛选条件（`actionsApi.page` 的 `name`、`failed`）；都不给时是全部。 */
export interface ActionFilter {
	name?: string;
	/** 只看失败的动作（没有标记）。 */
	failed?: boolean;
}

/** 这条明细符不符合筛选条件：实时推送不按筛选条件过滤，推送来的明细要自己挑。 */
export const matchesFilter = (detail: ActionDetailView, filter: ActionFilter): boolean =>
	(filter.name === undefined || detail.name === filter.name) &&
	(!filter.failed || (detail.kind === "action" && detail.result === "failed"));

export function fromLatestPage(page: ActionPage): ActionDetails {
	return {
		details: mergeDetails([], page.actions),
		controlPlanePeriods: mergePeriods([], page.count_only),
		before: page.before,
		rev: page.rev,
		expired: page.expired,
	};
}

/** 接上更早的一页（`before` 读到的）。 */
export function withOlderPage(d: ActionDetails, page: ActionPage): ActionDetails {
	return {
		...d,
		details: mergeDetails(d.details, page.actions),
		controlPlanePeriods: mergePeriods(d.controlPlanePeriods, page.count_only),
		before: page.before,
	};
}

/**
 * 实时推送来的一批明细（`accept` 挑出符合筛选条件的）。还有更早的页没读时，早于已读到的最早一条的不放进来：
 * 读那一页时会读到它（那时读到的是最新的），现在放进来会排在还没读到的明细的位置上。
 */
export function withLive(
	d: ActionDetails,
	actions: readonly ActionDetailView[],
	accept: (detail: ActionDetailView) => boolean = () => true,
): ActionDetails {
	const oldest = d.before === null ? undefined : d.details.at(-1);
	const kept = actions.filter((a) => accept(a) && (!oldest || compare(a, oldest) <= 0));
	return kept.length === 0 ? d : { ...d, details: mergeDetails(d.details, kept) };
}

/** 分页的顺序：开始时间从新到旧，同一时刻 ID 大的在前。负数表示 a 排在 b 前面。 */
function compare(a: ActionDetailView, b: ActionDetailView): number {
	return Date.parse(b.started_at) - Date.parse(a.started_at) || b.id - a.id;
}

/** 第一个不排在 `detail` 前面的位置（等于长度时在末尾）。 */
function lowerBound(sorted: readonly ActionDetailView[], detail: ActionDetailView): number {
	let lo = 0;
	let hi = sorted.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (compare(sorted[mid] as ActionDetailView, detail) < 0) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** 把 `incoming` 合并进有序的 `sorted`：已有的 ID 原位替换，新的插到它的位置。 */
function mergeDetails(
	sorted: readonly ActionDetailView[],
	incoming: readonly ActionDetailView[],
): readonly ActionDetailView[] {
	if (incoming.length === 0) return sorted;
	// 一批里同一个 ID 出现两次时，后一个为准。
	const latest = new Map(incoming.map((a) => [a.id, a]));
	const out = sorted.slice();
	const inserts: { at: number; detail: ActionDetailView }[] = [];
	for (const detail of latest.values()) {
		const at = lowerBound(sorted, detail);
		if (sorted[at]?.id === detail.id) out[at] = detail;
		else inserts.push({ at, detail });
	}
	if (inserts.length === 0) return out;
	inserts.sort((a, b) => a.at - b.at || compare(a.detail, b.detail));
	const merged: ActionDetailView[] = [];
	let next = 0;
	for (const { at, detail } of inserts) {
		while (next < at) merged.push(out[next++] as ActionDetailView);
		merged.push(detail);
	}
	while (next < out.length) merged.push(out[next++] as ActionDetailView);
	return merged;
}

const periodKey = (s: CountOnlyPeriod) => `${s.name}\n${s.reason}`;

/** 把一页的 `count_only` 里控制面兜底的段合并进来。 */
function mergePeriods(
	periods: readonly CountOnlyPeriod[],
	incoming: readonly CountOnlyPeriod[],
): readonly CountOnlyPeriod[] {
	const controlPlane = incoming.filter((p) => p.reason === "control_plane");
	if (controlPlane.length === 0) return periods;
	const byKey = new Map(periods.map((s) => [periodKey(s), s]));
	for (const s of controlPlane) byKey.set(periodKey(s), s);
	return [...byKey.values()].sort((a, b) => Date.parse(b.from) - Date.parse(a.from));
}
