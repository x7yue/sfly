import { type ActionEvent, type ActionField, ActionResult as ProtoActionResult } from "@sfly/proto";
import {
	type ActionDetailView,
	type ActionNameCount,
	type ActionResult,
	type CountOnlyPeriod,
	sdkCountOnlyPeriods,
	type TaskStatus,
} from "@sfly/schema";
import { recordableAgentTimeMs } from "../agents/agent-clock.js";
import type { taskActions } from "../db/schema.js";
import { isDoing } from "./action-summary.js";
import { actionField, actionName, actionReason, mergeFields } from "./action-text.js";

/**
 * 动作明细（规格 #345，docs/ARCHITECTURE.md §6.3「动作明细」）的纯逻辑：把 Agent 转发的一批事件（ActionBatch）
 * 排成要写进 `task_actions` 的行（控制面兜底的上限在这里执行），把存下的行换成接口里的 {@link ActionDetailView}
 * （任务结束以后还没结束的动作在这里记为未结束），算出一页明细范围里的只计数的段，以及分页游标的编码。
 */

/** 控制面兜底的上限，与 SDK 相同（sdk/python/src/sfly/actions.py 的 MAX_TOTAL、MAX_PER_NAME；字段数见 action-text.ts）。 */
export const TOTAL_DETAIL_LIMIT = 100_000;
export const NAME_DETAIL_LIMIT = 50_000;

/** `task_actions` 的一行。 */
export type StoredDetail = typeof taskActions.$inferSelect;

const RESULTS: Partial<Record<ProtoActionResult, ActionResult>> = {
	[ProtoActionResult.SUCCESS]: "success",
	[ProtoActionResult.FAILED]: "failed",
	[ProtoActionResult.UNFINISHED]: "unfinished",
};

/** 一个时刻：控制面时间（由单调时钟读数折算）、Agent 时间和单调时钟读数本身。 */
interface Moment {
	at: Date;
	agentAt: Date;
	mono: number;
}

/** 一个事件：时间已经折算，名称、字段和原因里的 secret 已经打码、超长的已经截断。 */
export type PreparedEvent =
	| (Moment & {
			kind: "action" | "mark";
			id: number;
			parent: number | null;
			depth: number;
			name: string;
			fields: Record<string, string>;
			/** 补发的开始（超过每种名称的上限、因为失败才补上明细）：只受合计上限的限制。 */
			late: boolean;
	  })
	| (Moment & {
			kind: "end";
			id: number;
			result: ActionResult;
			reason: string | null;
			/** note() 补充的字段。 */
			fields: Record<string, string>;
	  });

/**
 * 一批事件折算时间、打码并按 SDK 的上限截断（action-text.ts）。`controlPlaneTime` 把单调时钟读数折算成控制面时间（这次连接的对应关系，ADR 0018）。
 * 结果不是成功、失败、未结束之一的结束不合法，丢弃（同版本的 SDK 不会写出来）。
 */
export function prepareEvents(
	events: readonly ActionEvent[],
	controlPlaneTime: (monotonicMs: bigint) => Date,
	secrets: readonly string[],
): PreparedEvent[] {
	const prepared: PreparedEvent[] = [];
	for (const e of events) {
		const moment: Moment = {
			at: controlPlaneTime(e.monotonicMs),
			agentAt: new Date(recordableAgentTimeMs(e.timeUnixMs)),
			mono: Number(e.monotonicMs),
		};
		const { kind } = e;
		if (kind.case === "start" || kind.case === "mark") {
			const v = kind.value;
			prepared.push({
				...moment,
				kind: kind.case === "start" ? "action" : "mark",
				id: Number(v.id),
				parent: v.parent === undefined ? null : Number(v.parent),
				depth: v.depth,
				name: actionName(v.name, secrets),
				fields: fieldsOf(v.fields, secrets),
				late: kind.case === "start" && kind.value.late,
			});
		} else if (kind.case === "end") {
			const result = RESULTS[kind.value.result];
			if (!result) continue;
			const { reason } = kind.value;
			prepared.push({
				...moment,
				kind: "end",
				id: Number(kind.value.id),
				result,
				reason: result === "failed" && reason !== undefined ? actionReason(reason, secrets) : null,
				fields: fieldsOf(kind.value.fields, secrets),
			});
		}
	}
	return prepared;
}

/** 字段按写的先后，键和值打码、值截断（{@link actionField}）；超过 8 个时丢弃多出的（被改过的 SDK）。 */
function fieldsOf(
	fields: readonly ActionField[],
	secrets: readonly string[],
): Record<string, string> {
	return mergeFields(
		{},
		fields.map((f) => actionField(f.key, f.value, secrets)),
	);
}

/** 这一批里开始的动作和标记的名称（读每种名称已经存下的个数用）。 */
export const startedNames = (events: readonly PreparedEvent[]): string[] => [
	...new Set(events.flatMap((e) => (e.kind === "end" ? [] : [e.name]))),
];

/** 更早的一批里开始的动作结束：在库里补上结束。 */
export interface DetailEnd extends Moment {
	id: number;
	result: ActionResult;
	reason: string | null;
	/** note() 补充的字段，没有时为 null。 */
	noted: Record<string, string> | null;
}

/** 一种名称这一批被丢弃的明细：个数，和其中最早的开始。 */
export interface DroppedDetails {
	count: number;
	from: Date;
	agentFrom: Date;
}

export interface BatchPlan {
	/**
	 * 要插入的行（开始、标记）：同一批里结束了的动作已经带上结束，`end` 是那个结束（库里已经有这一行、插入被忽略时，
	 * 改按 `end` 给已有的行补上结束）；`late` 是补发的开始。
	 */
	inserts: Array<{ row: StoredDetail; late: boolean; end?: DetailEnd }>;
	ends: DetailEnd[];
	/** 名称 → 控制面兜底丢弃的明细。 */
	dropped: Map<string, DroppedDetails>;
}

/**
 * 按到达的先后排一批事件（docs/ARCHITECTURE.md §6.3「动作明细」）：开始和标记在合计已满，或者（不是补发的且）这个名称
 * 已满时丢弃；结束只对已有的行生效，所以被丢弃的开始，它的结束没有对象。同一批里开始又结束的动作直接是完整的一行。
 * 同一个 ID 在这一批里再出现时忽略（与库里已有的重复由插入时忽略，它在这一批里的结束改补到已有的行上，见 `end`）。
 * `counts` 是写入这一批之前任务已存的明细条数和这一批涉及的名称已存的个数（不含补发的）。
 */
export function planBatch(
	taskId: string,
	rev: number,
	events: readonly PreparedEvent[],
	counts: { details: number; stored: ReadonlyMap<string, number> },
): BatchPlan {
	let details = counts.details;
	const stored = new Map(counts.stored);
	const plan: BatchPlan = { inserts: [], ends: [], dropped: new Map() };
	/** 这一批里出现过开始或标记的 ID（存下的、丢弃的都算）。 */
	const begun = new Set<number>();
	/** 这一批里开始、还没结束的动作。 */
	const open = new Map<number, BatchPlan["inserts"][number]>();
	const ended = new Set<number>();
	for (const e of events) {
		if (e.kind === "end") {
			if (ended.has(e.id)) continue;
			ended.add(e.id);
			const { id, at, agentAt, mono, result, reason } = e;
			const end: DetailEnd = {
				id,
				at,
				agentAt,
				mono,
				result,
				reason,
				noted: Object.keys(e.fields).length > 0 ? e.fields : null,
			};
			const insert = open.get(e.id);
			if (insert) {
				const { row } = insert;
				Object.assign(row, endOf(row, e), {
					fields: mergeFields(row.fields, Object.entries(e.fields)),
				});
				insert.end = end;
			} else if (!begun.has(e.id)) {
				plan.ends.push(end);
			}
			continue;
		}
		if (begun.has(e.id)) continue;
		begun.add(e.id);
		const named = stored.get(e.name) ?? 0;
		if (details >= TOTAL_DETAIL_LIMIT || (!e.late && named >= NAME_DETAIL_LIMIT)) {
			const seen = plan.dropped.get(e.name);
			if (!seen) plan.dropped.set(e.name, { count: 1, from: e.at, agentFrom: e.agentAt });
			else {
				seen.count += 1;
				if (e.at < seen.from) Object.assign(seen, { from: e.at, agentFrom: e.agentAt });
			}
			continue;
		}
		details += 1;
		if (!e.late) stored.set(e.name, named + 1);
		const row: StoredDetail = {
			taskId,
			id: e.id,
			kind: e.kind,
			parent: e.parent,
			depth: e.depth,
			name: e.name,
			fields: e.fields,
			noted: null,
			startedAt: e.at,
			agentStartedAt: e.agentAt,
			startMono: e.mono,
			endedAt: null,
			agentEndedAt: null,
			durationMs: null,
			result: null,
			reason: null,
			rev,
		};
		const insert = { row, late: e.late };
		plan.inserts.push(insert);
		if (e.kind === "action") open.set(e.id, insert);
	}
	return plan;
}

/** 一个动作结束时要写的几列：耗时是两个单调时钟读数之差，Agent 的系统时间被改动不影响。 */
const endOf = (row: Pick<StoredDetail, "startMono">, end: Omit<DetailEnd, "id" | "noted">) => ({
	endedAt: end.at,
	agentEndedAt: end.agentAt,
	durationMs: Math.max(0, end.mono - row.startMono),
	result: end.result,
	reason: end.reason,
});

/** 任务怎么结束的：还没结束的动作按它记为未结束。 */
export interface TaskEnd {
	endedAt: Date;
	/** 任务结束（取不到时开始）时测得的时钟偏差（Agent 时间 − 控制面时间）；都没有时为 null。 */
	agentOffsetMs: number | null;
}

/** 任务已经不在执行（也有结束时间）时它怎么结束的；还在执行、还没开始时为 null。 */
export function taskEndOf(task: {
	status: TaskStatus;
	endedAt: Date | null;
	startClockOffsetMs: number | null;
	endClockOffsetMs: number | null;
}): TaskEnd | null {
	if (isDoing(task.status) || task.endedAt === null) return null;
	return {
		endedAt: task.endedAt,
		agentOffsetMs: task.endClockOffsetMs ?? task.startClockOffsetMs,
	};
}

/**
 * 存下的一行 → 接口里的明细。补充的字段覆盖到开始时的字段上。任务已经结束（`end` 不为 null）时，还没结束的动作
 * 记为未结束：结束时间取任务的结束时间，Agent 时间按任务的时钟偏差折算，耗时按控制面时间算。任务结束以后不再写入
 * 明细（TaskActions 整批丢弃之后才到的），所以未结束定格在任务结束的那一刻，任务怎么结束（成功、失败、取消、
 * `agent_lost`）都一样。
 */
export function detailView(row: StoredDetail, end: TaskEnd | null): ActionDetailView {
	const base = {
		id: row.id,
		parent: row.parent,
		depth: row.depth,
		name: row.name,
		fields: row.noted ? mergeFields(row.fields, Object.entries(row.noted)) : row.fields,
		started_at: row.startedAt.toISOString(),
		agent_started_at: row.agentStartedAt.toISOString(),
	};
	if (row.kind === "mark") return { kind: "mark", ...base };
	if (row.result === null && end) {
		const { endedAt, agentOffsetMs } = end;
		return {
			kind: "action",
			...base,
			result: "unfinished",
			ended_at: endedAt.toISOString(),
			agent_ended_at:
				agentOffsetMs === null
					? null
					: new Date(recordableAgentTimeMs(endedAt.getTime() + agentOffsetMs)).toISOString(),
			duration_ms: Math.max(0, endedAt.getTime() - row.startedAt.getTime()),
			reason: null,
		};
	}
	return {
		kind: "action",
		...base,
		result: row.result,
		ended_at: row.endedAt?.toISOString() ?? null,
		agent_ended_at: row.agentEndedAt?.toISOString() ?? null,
		duration_ms: row.durationMs,
		reason: row.reason,
	};
}

/** 只计数的段的来源：动作摘要里每种名称的计数和合计已满的时刻，以及控制面兜底丢弃的明细（`task_action_names`）。 */
export interface CountOnlySources {
	names: readonly ActionNameCount[];
	cappedAt: string | null;
	dropped: ReadonlyArray<{
		name: string;
		dropped: number;
		droppedFrom: Date | null;
		agentDroppedFrom: Date | null;
	}>;
	/** 任务的结束时间；还在执行时为 null。 */
	to: Date | null;
}

/**
 * 一页明细范围里的只计数的段，从新到旧（docs/ARCHITECTURE.md §6.3「只计数的段」）：SDK 上限的段由摘要算出
 * （`sdkCountOnlyPeriods`，web 用同一份），加上控制面兜底丢弃的。范围是 `[from, until)`（毫秒，控制面时间），
 * null 是那一边没有界限。
 */
export function countOnlyPeriods(
	sources: CountOnlySources,
	filter: { name?: string; failed?: boolean },
	range: { from: number | null; until: number | null },
): CountOnlyPeriod[] {
	const to = sources.to?.toISOString() ?? null;
	const periods = sdkCountOnlyPeriods(
		{ names: sources.names, capped_at: sources.cappedAt },
		filter,
		to,
	);
	for (const d of sources.dropped) {
		if (d.dropped <= 0 || !d.droppedFrom) continue;
		if (filter.name !== undefined && d.name !== filter.name) continue;
		const from = d.droppedFrom.toISOString();
		periods.push({
			name: d.name,
			reason: "control_plane",
			from,
			agent_from: d.agentDroppedFrom?.toISOString() ?? from,
			to,
			count: d.dropped,
		});
	}
	return periods
		.filter((p) => {
			const at = Date.parse(p.from);
			return (
				(range.from === null || at >= range.from) && (range.until === null || at < range.until)
			);
		})
		.sort((a, b) => Date.parse(b.from) - Date.parse(a.from));
}

/**
 * 明细的分页游标：一页最早那条的开始时间（控制面时间，毫秒）和 ID，对外是不透明字符串。写法是标记 `a`、
 * 开始时间和 ID 两个 36 进制数，中间用 `.` 隔开。
 */
export interface ActionCursor {
	startedAtMs: number;
	id: number;
}

const CURSOR = /^a(-?[0-9a-z]{1,11})\.([0-9a-z]{1,11})$/;
/** Date 能表示的最大毫秒数。 */
const MAX_DATE_MS = 8.64e15;

export const encodeActionCursor = (row: Pick<StoredDetail, "startedAt" | "id">): string =>
	`a${row.startedAt.getTime().toString(36)}.${row.id.toString(36)}`;

/** 不是 {@link encodeActionCursor} 编码出来的字符串时为 undefined。 */
export function decodeActionCursor(cursor: string): ActionCursor | undefined {
	const match = CURSOR.exec(cursor);
	if (!match) return undefined;
	const startedAtMs = Number.parseInt(match[1] as string, 36);
	const id = Number.parseInt(match[2] as string, 36);
	if (Math.abs(startedAtMs) > MAX_DATE_MS || !Number.isSafeInteger(id)) return undefined;
	return { startedAtMs, id };
}
