import {
	type ActionDetailView,
	type ActionResult,
	type ActionSummaryView,
	type CountOnlyPeriod,
	type EndedActionView,
	type RunningActionView,
	sdkCountOnlyPeriods,
} from "@sfly/schema";
import { ACTION_PAGE, NODE_ACTIONS } from "#/lib/copy";
import {
	type ActionFilter,
	byNewest,
	matchesFilter,
	matchesName,
	NO_FILTER,
	partitionPoint,
	periodKey,
} from "./action-details";

/**
 * 运行监控「动作」页签的表格（规格 #345）：摘要、分页读到的明细、只计数的段整理成三组行。
 *
 * - 「正在做」「最近 20 个」只取摘要：超出上限前后都准确，也不用等明细送到；
 * - 「更早的明细」是分页和推送读到的明细，去掉已经在前两组里的 ID；只计数的段插在开始时间早于它起点的
 *   第一条明细前面：SDK 上限的段也只取摘要，控制面兜底的段取分页读到的。
 *
 * 每组按开始时间从新到旧，没有行的组不出现。
 *
 * 筛选（名称、只看失败）时三组都只留符合条件的：正在做的动作还没有结果，只看失败时那一组不出现；明细本来就是按
 * 同一个条件读的，这里再挑一遍，换条件之后缓冲里还没换掉的明细不会混进来。只计数的段按同一个条件取（`sdkCountOnlyPeriods`）。
 * 只看失败时，只计数的段里没有明细的那些动作可能有失败的：个数里成功的失败的都有，写明失败的个数不知道。
 */

export type ActionGroupName = "running" | "recent" | "earlier";

/** 一个动作的结果：还在做（耗时是已持续多久，界面按秒刷新）、成功、未结束、失败（带完整的原因）。 */
export type ActionOutcome =
	| { status: "running" }
	| { status: Exclude<ActionResult, "failed">; durationMs: number }
	| { status: "failed"; durationMs: number; reason: string | null };

/** 子动作缩进的层数：最多 3 层，更深的画在第 3 层。 */
export type Indent = 0 | 1 | 2 | 3;
const INDENT_MAX = 3;

interface RecordRow {
	/** 表格里的唯一键（动作和标记共用一个 ID 序列，一个 ID 在表里只出现一次）。 */
	key: string;
	id: number;
	name: string;
	fields: Readonly<Record<string, string>>;
	indent: Indent;
	/** 开始（标记是发生）的控制面时间。 */
	startedAt: string;
	/** 开始的 Agent 时间。 */
	agentStartedAt: string;
}

export type ActionRow =
	| (RecordRow & { kind: "action"; outcome: ActionOutcome })
	| (RecordRow & { kind: "mark" })
	| {
			kind: "count-only";
			key: string;
			name: string;
			reason: CountOnlyPeriod["reason"];
			/** 合计也已满：每种名称上限的段里，合计满了以后失败的动作也没有明细了。 */
			totalFull: boolean;
			/**
			 * 只看失败时才有：这一段里失败的个数不知道（个数包括成功的）；`total` 是这个名称一共失败的个数
			 * （摘要里的，不论有没有明细），摘要里还没有这个名称时为 null。
			 */
			failedGap: { total: number | null } | null;
			/** 从什么时候起（控制面时间）。 */
			from: string;
			/** 从什么时候起（Agent 时间）。 */
			agentFrom: string;
			/** 到什么时候：任务结束的时间；还在执行时为 null（至今）。 */
			until: string | null;
			count: number;
	  };

export interface ActionTableGroup {
	name: ActionGroupName;
	rows: readonly ActionRow[];
}

/** 说明字段写成一行：「订单=P-1284814 方向=买」，按写入的先后。 */
export const fieldsText = (fields: Readonly<Record<string, string>>): string =>
	Object.entries(fields)
		.map(([k, v]) => `${k}=${v}`)
		.join(" ");

/** 动作的个数（页签上写的）：标记不算。 */
export const actionCount = (summary: ActionSummaryView): number => summary.total - summary.marks;

/**
 * 三组标题后面的说明。「最近 20 个」取自摘要，不受明细上限影响，所以 SDK 超出上限（摘要的 `capped`）或者读到了
 * 控制面丢弃的段时写明；只看失败时第三组说失败的动作有没有明细（合计满了没有；没满有，控制面丢弃的除外）。
 * 控制面丢弃的段只随分页返回、摘要里没有：更早的页没读完（`hasOlder`）时可能还没读到，第三组按「可能有」写。
 */
export function groupNotes({
	summary,
	controlPlanePeriods,
	hasOlder,
	failedOnly,
}: {
	summary: ActionSummaryView;
	controlPlanePeriods: readonly CountOnlyPeriod[];
	hasOlder: boolean;
	failedOnly: boolean;
}): Partial<Record<ActionGroupName, string>> {
	const dropped = controlPlanePeriods.length > 0;
	return {
		...(!summary.running_complete && {
			running: NODE_ACTIONS.runningIncomplete(summary.running.length),
		}),
		...((summary.capped || dropped) && { recent: ACTION_PAGE.recentKeepsUpdating }),
		...(failedOnly && {
			earlier: ACTION_PAGE.earlierFailedNote(summary.capped_at !== null, dropped || hasOlder),
		}),
	};
}

export function actionTable({
	summary,
	details,
	controlPlanePeriods,
	hasOlder,
	endedAt,
	filter = NO_FILTER,
}: {
	summary: ActionSummaryView;
	/** 分页和推送读到的明细，按开始时间从新到旧（`action-details.ts`）。 */
	details: readonly ActionDetailView[];
	/** 分页读到的控制面兜底的只计数的段。 */
	controlPlanePeriods: readonly CountOnlyPeriod[];
	/** 还有更早的明细没读。 */
	hasOlder: boolean;
	/** 这次尝试结束的时间：还在执行的只计数的段到这里为止；还在执行时为 null。 */
	endedAt: string | null;
	filter?: ActionFilter;
}): ActionTableGroup[] {
	const doing = filter.failed ? [] : summary.running.filter((a) => matchesName(a, filter));
	const recent = summary.recent.filter((a) => matchesFilter({ ...a, kind: "action" }, filter));
	const shown = new Set<number>();
	for (const a of doing) shown.add(a.id);
	for (const a of recent) shown.add(a.id);
	const earlier = details.filter((d) => !shown.has(d.id) && matchesFilter(d, filter));
	const groups: ActionTableGroup[] = [
		{ name: "running", rows: [...doing].sort(byNewest).map(runningRow) },
		{ name: "recent", rows: [...recent].sort(byNewest).map(endedRow) },
		{
			name: "earlier",
			rows: withPeriods(
				earlier,
				periodRows(summary, details, controlPlanePeriods, hasOlder, endedAt, filter),
			),
		},
	];
	return groups.filter((g) => g.rows.length > 0);
}

const startOf = (a: { started_at: string }) => Date.parse(a.started_at);

/** 只计数的段（起点从新到旧）插进明细：放在开始时间早于它起点的第一条明细前面，没有这样的明细时放在最后。 */
function withPeriods(
	details: readonly ActionDetailView[],
	periods: Extract<ActionRow, { kind: "count-only" }>[],
): ActionRow[] {
	const rows: ActionRow[] = [];
	let next = 0;
	for (const period of periods) {
		const from = Date.parse(period.from);
		const at = partitionPoint(details, (d) => startOf(d) >= from, next);
		while (next < at) rows.push(detailRow(details[next++] as ActionDetailView));
		rows.push(period);
	}
	while (next < details.length) rows.push(detailRow(details[next++] as ActionDetailView));
	return rows;
}

/**
 * 要显示的只计数的段，按起点从新到旧。SDK 上限的段由最新的摘要算出（`sdkCountOnlyPeriods`，与控制面同一份）：
 * 任务还在执行时个数一直在涨，执行中才开始只计数的名称也马上有。控制面兜底的段摘要里没有，用分页读到的。
 * 还有更早的明细没读时，SDK 上限的段只显示起点不早于已读到的最早一条明细的：更早的要读到那一页才排得进明细里。
 */
function periodRows(
	summary: ActionSummaryView,
	details: readonly ActionDetailView[],
	controlPlanePeriods: readonly CountOnlyPeriod[],
	hasOlder: boolean,
	endedAt: string | null,
	filter: ActionFilter,
): Extract<ActionRow, { kind: "count-only" }>[] {
	const oldest = hasOlder ? details.at(-1) : undefined;
	const fromSummary = sdkCountOnlyPeriods(summary, filter, endedAt).filter(
		(p) => !oldest || Date.parse(p.from) >= startOf(oldest),
	);
	const fromControlPlane = controlPlanePeriods.filter((p) => matchesName(p, filter));
	return [...fromSummary, ...fromControlPlane]
		.flatMap((p): Extract<ActionRow, { kind: "count-only" }>[] => {
			const failed = summary.names.find((n) => n.name === p.name)?.failed;
			// 只看失败：这个名称一个都没有失败过，就没有失败的明细缺口。
			if (filter.failed && failed === 0) return [];
			return [
				{
					kind: "count-only",
					key: `c:${periodKey(p)}`,
					name: p.name,
					reason: p.reason,
					totalFull: summary.capped_at !== null,
					failedGap: filter.failed ? { total: failed ?? null } : null,
					from: p.from,
					agentFrom: p.agent_from,
					until: p.to ?? endedAt,
					count: p.count,
				},
			];
		})
		.sort((a, b) => Date.parse(b.from) - Date.parse(a.from));
}

/** 动作的缩进层数：深度从 0 数起，更深的画在第 3 层。检查器的「正在做」和「动作」页签共用。 */
export const indentOf = (depth: number) => Math.min(Math.max(depth, 0), INDENT_MAX) as Indent;

function recordRow(a: RunningActionView | ActionDetailView): RecordRow {
	return {
		key: `a:${a.id}`,
		id: a.id,
		name: a.name,
		fields: a.fields,
		indent: indentOf(a.depth),
		startedAt: a.started_at,
		agentStartedAt: a.agent_started_at,
	};
}

function ended(result: ActionResult, durationMs: number, reason: string | null): ActionOutcome {
	return result === "failed"
		? { status: result, durationMs, reason }
		: { status: result, durationMs };
}

const runningRow = (a: RunningActionView): ActionRow => ({
	...recordRow(a),
	kind: "action",
	outcome: { status: "running" },
});

const endedRow = (a: EndedActionView): ActionRow => ({
	...recordRow(a),
	kind: "action",
	outcome: ended(a.result, a.duration_ms, a.reason),
});

/** 明细的行。明细最多 10 万条、每批推送都重新整理一遍，所以同一条明细只换算一次（推送来的新版本是新的对象）。 */
const detailRows = new WeakMap<ActionDetailView, ActionRow>();

function detailRow(d: ActionDetailView): ActionRow {
	const cached = detailRows.get(d);
	if (cached) return cached;
	const row: ActionRow =
		d.kind === "mark"
			? { ...recordRow(d), kind: "mark" }
			: {
					...recordRow(d),
					kind: "action",
					outcome:
						d.result === null
							? { status: "running" }
							: ended(d.result, d.duration_ms ?? 0, d.reason),
				};
	detailRows.set(d, row);
	return row;
}
