import type {
	ActionDetailView,
	ActionPage,
	ActionSummaryView,
	CountOnlyPeriod,
} from "@sfly/schema";

/**
 * 一个任务（一次尝试）已经读到的动作明细：分页读到的加上实时推送来的（`use-task-actions.ts` 持有它）。
 *
 * 明细最多 10 万条，每秒可能推送好几批，所以只用一个有序数组：位置按二分查找，一批合并只复制一次数组。
 * 同一个 ID 的开始时间不会变（控制面写下开始时就定了，之后只补上结束），所以按开始时间和 ID 找到的就是它原来的位置。
 */
export interface ActionDetails {
	/** 按开始时间从新到旧（同一时刻 ID 大的在前，与分页的顺序相同），同一个 ID 只有一条，后到的为准。 */
	readonly details: readonly ActionDetailView[];
	/** 分页读到的只计数的段，同一个名称、同一种原因只有一段（后读到的为准），按起点从新到旧。 */
	readonly countOnly: readonly CountOnlyPeriod[];
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
		countOnly: mergePeriods([], page.count_only),
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
		countOnly: mergePeriods(d.countOnly, page.count_only),
		before: page.before,
	};
}

/**
 * 重新读到的最新一页（有名称刚开始只计数时，见 {@link newlyCapped}）：明细和只计数的段合并进来，
 * 更早一页的游标和实时推送的起点不变（推送一直连着，这一页的明细它都会送到）。
 */
export function withLatestPage(d: ActionDetails, page: ActionPage): ActionDetails {
	return {
		...d,
		details: mergeDetails(d.details, page.actions),
		countOnly: mergePeriods(d.countOnly, page.count_only),
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

/**
 * 有没有名称在这两份摘要之间刚开始只计数（`capped_at` 从没有变成有）。这时它的只计数的段落在最新一页的范围里，
 * 而只计数的段只随分页返回，要重新读一次最新的一页。没有上一份摘要时不算（读第一页时它已经在里面了）。
 */
export function newlyCapped(
	previous: ActionSummaryView | undefined,
	next: ActionSummaryView,
): boolean {
	if (!previous) return false;
	const before = new Set(previous.names.filter((n) => n.capped_at !== null).map((n) => n.name));
	return next.names.some((n) => n.capped_at !== null && !before.has(n.name));
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

function mergePeriods(
	periods: readonly CountOnlyPeriod[],
	incoming: readonly CountOnlyPeriod[],
): readonly CountOnlyPeriod[] {
	if (incoming.length === 0) return periods;
	const byKey = new Map(periods.map((s) => [periodKey(s), s]));
	for (const s of incoming) byKey.set(periodKey(s), s);
	return [...byKey.values()].sort((a, b) => Date.parse(b.from) - Date.parse(a.from));
}
