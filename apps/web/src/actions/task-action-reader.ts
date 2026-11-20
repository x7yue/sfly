import type { ActionDetailView, ActionPage, CountOnlyPeriod } from "@sfly/schema";
import { createStore, type Reader } from "#/lib/reader";
import {
	type ActionFilter,
	byNewest,
	matchesFilter,
	NO_FILTER,
	partitionPoint,
	periodKey,
} from "./action-details";

/**
 * 一个任务（一次尝试）的动作明细读取器（单测见 task-action-reader.test.ts）：先读最新的一页明细，再用它的修订号
 * 接上实时推送（断线后 API 客户端带 `Last-Event-ID` 接上），`loadOlder()` 往前翻页。推送来的明细按筛选条件挑过
 * 再合并。合并规则和读取时序都在这里。
 *
 * 合并规则：明细最多 10 万条，每秒可能推送好几批，所以只用一个有序数组：位置按二分查找，一批合并只复制一次数组。
 * 同一个 ID 的开始时间不会变（控制面写下开始时就定了，之后只补上结束），所以按开始时间和 ID 找到的就是它原来的位置。
 *
 * 读取时序：
 * - 实时推送在最新一页读到之后才连，从它的修订号 `rev` 接上；更早一页的 `rev` 不算；运行已超过保留期时不连。
 * - 往前翻页同一时刻只读一页，没有更早的明细时不读。
 * - 读第一页失败时 `retry()` 重读；读更早的一页失败时再 `loadOlder()` 就会重读。
 * - 读取器 `dispose` 之后（任务或筛选条件变了），在途的结果都作废。
 */

/** 读到的明细：分页读到的加上实时推送来的。 */
interface ActionDetails {
	/** 按开始时间从新到旧（同一时刻 ID 大的在前，与分页的顺序相同），同一个 ID 只有一条，后到的为准。 */
	readonly details: readonly ActionDetailView[];
	/**
	 * 分页读到的控制面兜底的只计数的段（`control_plane`），同一个名称只有一段（后读到的为准）。
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

/** 读取器对外的状态。 */
export interface TaskActionState {
	/** 读到的明细，按开始时间从新到旧，同一个 ID 只有一条。 */
	readonly details: readonly ActionDetailView[];
	/** 分页读到的控制面兜底的只计数的段；SDK 上限的段由摘要算出（action-table.ts）。 */
	readonly controlPlanePeriods: readonly CountOnlyPeriod[];
	/** 读到了第一页。 */
	readonly loaded: boolean;
	/** 还有更早的明细没读：`loadOlder()` 读下一页。 */
	readonly hasOlder: boolean;
	readonly loadingOlder: boolean;
	/** 运行已超过保留期，明细已被清理。 */
	readonly expired: boolean;
	/** 最近一次读取失败的原因；`retry()` 重读第一页时清掉。 */
	readonly error: Error | null;
}

export interface TaskActionReader extends Reader<TaskActionState> {
	/** 读更早的一页（`before` 游标）；已经读到最早的明细、或有一页还在读时不读。 */
	loadOlder(): void;
	/** 第一页读失败后重读；其他时候不读。 */
	retry(): void;
}

/** 读取器向下依赖的两个口：读一页、订阅实时。每页明细数、名称和只看失败的筛选由适配器带上。 */
export interface TaskActionPorts {
	/** 读一页：不给 `before` 是最新一页，给了是用游标往前翻的一页。 */
	readPage(position: { before?: string }): Promise<ActionPage>;
	/** 订阅实时推送：从最新一页的修订号 `after` 接上，`onActions` 是一批新写入或刚结束的明细；返回断开函数。 */
	subscribeLive(
		after: number,
		onActions: (actions: readonly ActionDetailView[]) => void,
	): () => void;
}

const NONE: readonly never[] = [];

export const emptyTaskActions: TaskActionState = {
	details: NONE,
	controlPlanePeriods: NONE,
	loaded: false,
	hasOlder: false,
	loadingOlder: false,
	expired: false,
	error: null,
};

const noDetails: ActionDetails = {
	details: NONE,
	controlPlanePeriods: NONE,
	before: null,
	rev: 0,
	expired: false,
};

/** 新建一个读取器，立刻开始读第一页。`filter` 是读历史时带的筛选条件，推送来的明细也按它挑。 */
export function createTaskActionReader(
	ports: TaskActionPorts,
	filter: ActionFilter = NO_FILTER,
): TaskActionReader {
	const store = createStore(emptyTaskActions);
	let buffer = noDetails;
	let closeLive: (() => void) | null = null;
	let disposed = false;

	const publish = (patch: Partial<TaskActionState> = {}) =>
		store.set({
			details: buffer.details,
			controlPlanePeriods: buffer.controlPlanePeriods,
			hasOlder: buffer.before !== null,
			expired: buffer.expired,
			...patch,
		});

	const readFirstPage = () => {
		publish({ error: null });
		ports.readPage({}).then(
			(page) => {
				if (disposed) return;
				buffer = fromLatestPage(page);
				publish({ loaded: true });
				if (buffer.expired) return;
				closeLive = ports.subscribeLive(buffer.rev, (actions) => {
					const next = withLive(buffer, actions, (detail) => matchesFilter(detail, filter));
					if (next === buffer) return;
					buffer = next;
					publish();
				});
			},
			(e: Error) => {
				if (disposed) return;
				publish({ error: e });
			},
		);
	};

	readFirstPage();

	return {
		get: store.get,
		subscribe: store.subscribe,
		loadOlder() {
			const { before } = buffer;
			if (disposed || before === null || store.get().loadingOlder) return;
			publish({ loadingOlder: true });
			ports.readPage({ before }).then(
				(page) => {
					if (disposed) return;
					buffer = withOlderPage(buffer, page);
					publish({ loadingOlder: false });
				},
				(e: Error) => {
					if (disposed) return;
					publish({ error: e, loadingOlder: false });
				},
			);
		},
		retry() {
			const { loaded, error } = store.get();
			if (!disposed && !loaded && error !== null) readFirstPage();
		},
		dispose() {
			disposed = true;
			closeLive?.();
		},
	};
}

function fromLatestPage(page: ActionPage): ActionDetails {
	return {
		details: mergeDetails([], page.actions),
		controlPlanePeriods: mergePeriods([], page.count_only),
		before: page.before,
		rev: page.rev,
		expired: page.expired,
	};
}

/** 接上更早的一页（`before` 读到的）。 */
function withOlderPage(d: ActionDetails, page: ActionPage): ActionDetails {
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
function withLive(
	d: ActionDetails,
	actions: readonly ActionDetailView[],
	accept: (detail: ActionDetailView) => boolean,
): ActionDetails {
	const oldest = d.before === null ? undefined : d.details.at(-1);
	const kept = actions.filter((a) => accept(a) && (!oldest || byNewest(a, oldest) <= 0));
	return kept.length === 0 ? d : { ...d, details: mergeDetails(d.details, kept) };
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
		const at = partitionPoint(sorted, (d) => byNewest(d, detail) < 0);
		if (sorted[at]?.id === detail.id) out[at] = detail;
		else inserts.push({ at, detail });
	}
	if (inserts.length === 0) return out;
	inserts.sort((a, b) => a.at - b.at || byNewest(a.detail, b.detail));
	const merged: ActionDetailView[] = [];
	let next = 0;
	for (const { at, detail } of inserts) {
		while (next < at) merged.push(out[next++] as ActionDetailView);
		merged.push(detail);
	}
	while (next < out.length) merged.push(out[next++] as ActionDetailView);
	return merged;
}

/** 把一页的 `count_only` 里控制面兜底的段合并进来。 */
function mergePeriods(
	periods: readonly CountOnlyPeriod[],
	incoming: readonly CountOnlyPeriod[],
): readonly CountOnlyPeriod[] {
	const controlPlane = incoming.filter((p) => p.reason === "control_plane");
	if (controlPlane.length === 0) return periods;
	const byKey = new Map(periods.map((s) => [periodKey(s), s]));
	for (const s of controlPlane) byKey.set(periodKey(s), s);
	return [...byKey.values()];
}
