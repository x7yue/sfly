import {
	ActionResult,
	type ActionSummaryView,
	type CurrentAction,
	type EndedActionView,
	type RunningActionView,
	type TaskStatus,
} from "@sfly/schema";
import { z } from "zod";
import { recordableAgentTimeMs } from "../agents/agent-clock.js";
import { maskSecrets } from "../logs/secrets.js";
import { actionField, actionName, actionReason } from "./action-text.js";

/**
 * 动作摘要（规格 #345）的纯逻辑：解析 SDK 写的 `action_summary` 事件（格式见 sdk/python/src/sfly/context.py），
 * 换成接口里的 {@link ActionSummaryView}，选出此刻在做的动作（{@link CurrentAction}）。
 *
 * - 时间：事件里每个时刻都有 Agent 时间（`ts`）和单调时钟读数（`mono`）；控制面时间由读数按连接的对应关系折算
 *   （ADR 0018），耗时用两个读数的差，Agent 时间原样记下。
 * - 上限：正在做的、最近结束的、最近失败的按 SDK 的上限截断，被改过的 SDK 也写不出更长的摘要。
 * - 任务结束以后，正在做的动作由读取的一方当作空的（{@link summaryOfTask}、{@link currentActionOfTask}）：
 *   任务怎么结束（成功、失败、取消、`agent_lost`）都一样，不用在每个结束的地方改存下的摘要。
 */

/** SDK 摘要里各列表的上限（sdk/python/src/sfly/actions.py 的 RUNNING_LIMIT、RECENT_LIMIT、RECENT_FAILED_LIMIT）。 */
export const RUNNING_LIMIT = 50;
const RECENT_LIMIT = 20;
const RECENT_FAILED_LIMIT = 5;
/**
 * 摘要里最多列多少种名称：SDK 不限（超过 100 种时在任务日志里警告一次），名称里带订单号这样的写法会让每秒一份的摘要
 * 越来越大，这里只存前这么多种（SDK 按第一次出现的先后列），合计和其余字段照常。
 */
export const SUMMARY_NAMES_LIMIT = 1000;

const Running = z.object({
	id: z.number().int(),
	parent: z.number().int().nullable(),
	depth: z.number().int().nonnegative(),
	name: z.string(),
	fields: z.record(z.string(), z.string()),
	ts: z.number(),
	mono: z.number(),
});

const Ended = Running.extend({
	end_ts: z.number(),
	end_mono: z.number(),
	result: ActionResult,
	reason: z.string().nullable(),
});

const NameCount = z.object({
	name: z.string(),
	total: z.number().int(),
	failed: z.number().int(),
	reported: z.number().int(),
	capped_ts: z.number().nullable(),
	capped_mono: z.number().nullable(),
});

/** 事件管道里的一行 `action_summary`（ActionSummary.event_json）。 */
const ActionSummaryEvent = z.object({
	type: z.literal("action_summary"),
	total: z.number().int(),
	marks: z.number().int(),
	reported: z.number().int(),
	capped_ts: z.number().nullable(),
	capped_mono: z.number().nullable(),
	names: z.array(NameCount),
	running: z.array(Running),
	recent: z.array(Ended),
	recent_failed: z.array(Ended),
});

export type ActionSummaryEvent = z.infer<typeof ActionSummaryEvent>;

/** 解析 Agent 转发的那一行原文；不是合法的摘要时为 undefined。 */
export function parseActionSummary(eventJson: string): ActionSummaryEvent | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(eventJson);
	} catch {
		return undefined;
	}
	const parsed = ActionSummaryEvent.safeParse(raw);
	return parsed.success ? parsed.data : undefined;
}

/**
 * 一份摘要换成接口里的样子，并选出此刻在做的动作。`controlPlaneTime` 把单调时钟读数折算成那一刻的控制面时间
 * （这次连接的对应关系）；名称、字段、失败原因里的 secret 值打码，超长的按 SDK 的上限截断（action-text.ts），
 * 名称最多列 {@link SUMMARY_NAMES_LIMIT} 种。
 */
export function actionSummaryView(
	event: ActionSummaryEvent,
	controlPlaneTime: (monotonicMs: number) => Date,
	secrets: readonly string[],
): { summary: ActionSummaryView; current: CurrentAction | null } {
	const at = (mono: number) => controlPlaneTime(mono).toISOString();
	const agentAt = (ts: number) => new Date(recordableAgentTimeMs(ts)).toISOString();
	const name = (text: string) => actionName(text, secrets);
	const running = (a: z.infer<typeof Running>): RunningActionView => ({
		id: a.id,
		parent: a.parent,
		depth: a.depth,
		name: name(a.name),
		fields: Object.fromEntries(
			Object.entries(a.fields).map(([key, value]) => actionField(key, value, secrets)),
		),
		started_at: at(a.mono),
		agent_started_at: agentAt(a.ts),
	});
	const ended = (a: z.infer<typeof Ended>): EndedActionView => ({
		...running(a),
		ended_at: at(a.end_mono),
		agent_ended_at: agentAt(a.end_ts),
		duration_ms: Math.max(0, Math.round(a.end_mono - a.mono)),
		result: a.result,
		reason: a.reason === null ? null : actionReason(a.reason, secrets),
	});
	const cappedAt = (ts: number | null, mono: number | null) => ({
		capped_at: mono === null ? null : at(mono),
		agent_capped_at: ts === null ? null : agentAt(ts),
	});
	const doing = event.running.slice(0, RUNNING_LIMIT);
	const outermost = earliestOutermost(doing);
	return {
		summary: {
			total: event.total,
			marks: event.marks,
			reported: event.reported,
			capped: event.total > event.reported,
			...cappedAt(event.capped_ts, event.capped_mono),
			names: event.names.slice(0, SUMMARY_NAMES_LIMIT).map((n) => ({
				name: name(n.name),
				total: n.total,
				failed: n.failed,
				reported: n.reported,
				...cappedAt(n.capped_ts, n.capped_mono),
			})),
			running: doing.map(running),
			running_complete: event.running.length < RUNNING_LIMIT,
			recent: event.recent.slice(0, RECENT_LIMIT).map(ended),
			recent_failed: event.recent_failed.slice(0, RECENT_FAILED_LIMIT).map(ended),
		},
		current: outermost ? { name: name(outermost.name), started_at: at(outermost.mono) } : null,
	};
}

/**
 * 最外层（第 0 层）、开始得最早的那个正在做的动作。先后比单调时钟读数，不比 ID：多个线程同时开始动作时，
 * ID 的先后不一定是开始的先后。
 */
function earliestOutermost<A extends { depth: number; mono: number; id: number }>(
	running: readonly A[],
): A | undefined {
	let earliest: A | undefined;
	for (const a of running) {
		if (a.depth !== 0) continue;
		if (!earliest || a.mono < earliest.mono || (a.mono === earliest.mono && a.id < earliest.id))
			earliest = a;
	}
	return earliest;
}

/** 没有记录过动作的任务的摘要。 */
export const EMPTY_SUMMARY: ActionSummaryView = {
	total: 0,
	marks: 0,
	reported: 0,
	capped: false,
	capped_at: null,
	agent_capped_at: null,
	names: [],
	running: [],
	running_complete: true,
	recent: [],
	recent_failed: [],
};

/** 只有执行中的任务有正在做的动作：结束了的任务（以及还没开始执行的）都没有。 */
export const isDoing = (status: TaskStatus) => status === "running";

/** 任务的动作摘要：存下的最新一份；任务已经结束时正在做的动作为空。 */
export function summaryOfTask(
	status: TaskStatus,
	stored: ActionSummaryView | null,
): ActionSummaryView {
	if (!stored) return EMPTY_SUMMARY;
	return isDoing(status) ? stored : { ...stored, running: [], running_complete: true };
}

/**
 * 任务此刻在做的动作：存下的那一个，名称按 `secrets`（运行此刻的全部 secret 值）再打一遍码（写入时已经按那一刻的打过，
 * 之后才创建的子流程带来的 secret 也要算，和进度说明同一个口径）；任务已经结束时为 null。运行视图和 Agent 列表都用它。
 */
export function currentActionOfTask(
	status: TaskStatus,
	stored: CurrentAction | null,
	secrets: readonly string[],
): CurrentAction | null {
	return isDoing(status) && stored ? { ...stored, name: maskSecrets(stored.name, secrets) } : null;
}

/** 两个「此刻在做的动作」是不是同一个（名称和开始时间都相同）。 */
export const sameCurrentAction = (a: CurrentAction | null, b: CurrentAction | null): boolean =>
	a?.name === b?.name && a?.started_at === b?.started_at;
