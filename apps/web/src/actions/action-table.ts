import type {
	ActionDetailView,
	ActionResult,
	ActionSummaryView,
	CountOnlySpan,
	EndedActionView,
	RunningActionView,
} from "@sfly/schema";

/**
 * 运行监控「动作」页的表格（规格 #345）：摘要、分页读到的明细、只计数的段整理成三组行。
 *
 * - 「正在做」「最近 20 个」只取摘要：超出上限前后都准确，也不用等明细送到；
 * - 「更早的明细」是分页和推送读到的明细，去掉已经在前两组里的 ID；只计数的段插在开始时间早于它起点的
 *   第一条明细前面。
 *
 * 每组按开始时间从新到旧，没有行的组不出现。
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
			reason: CountOnlySpan["reason"];
			/** 从什么时候起（控制面时间）。 */
			from: string;
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

export function actionTable({
	summary,
	details,
	countOnly,
	endedAt,
}: {
	summary: ActionSummaryView;
	/** 分页和推送读到的明细，按开始时间从新到旧（`action-details.ts`）。 */
	details: readonly ActionDetailView[];
	countOnly: readonly CountOnlySpan[];
	/** 这次尝试结束的时间：还在执行的只计数的段到这里为止；还在执行时为 null。 */
	endedAt: string | null;
}): ActionTableGroup[] {
	const shown = new Set<number>();
	for (const a of summary.running) shown.add(a.id);
	for (const a of summary.recent) shown.add(a.id);
	const earlier = details.filter((d) => !shown.has(d.id));
	const groups: ActionTableGroup[] = [
		{ name: "running", rows: newestFirst(summary.running).map(runningRow) },
		{ name: "recent", rows: newestFirst(summary.recent).map(endedRow) },
		{ name: "earlier", rows: withSpans(earlier, spanRows(summary, countOnly, endedAt)) },
	];
	return groups.filter((g) => g.rows.length > 0);
}

const startOf = (a: { started_at: string }) => Date.parse(a.started_at);

function newestFirst<A extends { id: number; started_at: string }>(list: readonly A[]): A[] {
	return [...list].sort((a, b) => startOf(b) - startOf(a) || b.id - a.id);
}

/** 只计数的段（起点从新到旧）插进明细：放在开始时间早于它起点的第一条明细前面，没有这样的明细时放在最后。 */
function withSpans(
	details: readonly ActionDetailView[],
	spans: Extract<ActionRow, { kind: "count-only" }>[],
): ActionRow[] {
	const rows: ActionRow[] = [];
	let next = 0;
	for (const span of spans) {
		const at = firstStartedBefore(details, Date.parse(span.from), next);
		while (next < at) rows.push(detailRow(details[next++] as ActionDetailView));
		rows.push(span);
	}
	while (next < details.length) rows.push(detailRow(details[next++] as ActionDetailView));
	return rows;
}

/** 从 `from` 起，第一条开始时间早于 `time` 的明细的位置（明细从新到旧，所以二分查找）。 */
function firstStartedBefore(details: readonly ActionDetailView[], time: number, from: number) {
	let lo = from;
	let hi = details.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (startOf(details[mid] as ActionDetailView) >= time) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/**
 * 只计数的段，按起点从新到旧。SDK 上限的段，个数就是这个名称没有明细的 `total − reported` 个（docs/ARCHITECTURE.md
 * §6.3「只计数的段」），取最新的摘要：任务还在执行时它一直在涨，分页读到的是读那一刻的。控制面兜底的段摘要里没有，
 * 用分页读到的。
 */
function spanRows(
	summary: ActionSummaryView,
	spans: readonly CountOnlySpan[],
	endedAt: string | null,
): Extract<ActionRow, { kind: "count-only" }>[] {
	const unreported = new Map(summary.names.map((n) => [n.name, n.total - n.reported]));
	return [...spans]
		.sort((a, b) => Date.parse(b.from) - Date.parse(a.from))
		.map((s) => ({
			kind: "count-only",
			key: `c:${s.name}\n${s.reason}`,
			name: s.name,
			reason: s.reason,
			from: s.from,
			until: s.to ?? endedAt,
			count: (s.reason === "control_plane" ? undefined : unreported.get(s.name)) ?? s.count,
		}));
}

const indentOf = (depth: number) => Math.min(Math.max(depth, 0), INDENT_MAX) as Indent;

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
