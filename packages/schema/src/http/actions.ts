import { z } from "zod";
import { endpoint, Timestamp } from "./contract.js";

/**
 * 动作与标记的接口（GLOSSARY「动作」「标记」，规格 #345）。节点用 `ctx.action`、`ctx.mark` 记录，SDK 每秒最多发一份
 * 摘要（格式见 sdk/python/src/sfly/context.py），Agent 转发，控制面在任务上只存最新的一份
 * （apps/server/src/actions/）。时间都带两种（ADR 0018）：控制面时间由 SDK 写的单调时钟读数折算，Agent 时间原样保存。
 */

/** 路径里的任务 ID：不是 UUID 时控制面返回 404（与找不到相同），所以这里只要求是字符串。 */
const IdParams = z.object({ id: z.string() });

/** 动作的结果：成功、失败、未结束（任务结束时还没结束，或因为取消离开 `with`）。 */
export const ActionResult = z.enum(["success", "failed", "unfinished"]);

/** 一个正在做的动作。 */
export const RunningActionView = z.object({
	/** 任务内的动作 ID（动作和标记共用一个序列），先后不一定是开始的先后。 */
	id: z.number().int(),
	/** 父动作的 ID；最外层为 null。父动作不一定还在摘要里。 */
	parent: z.number().int().nullable(),
	/** 层级：最外层是 0。 */
	depth: z.number().int(),
	name: z.string(),
	/** 说明字段（值都是文字），开始时给的加上之后补充的。 */
	fields: z.record(z.string(), z.string()),
	/** 开始的控制面时间。 */
	started_at: Timestamp,
	/** 开始的 Agent 时间。 */
	agent_started_at: Timestamp,
});

/** 一个已经结束的动作。 */
export const EndedActionView = RunningActionView.extend({
	ended_at: Timestamp,
	agent_ended_at: Timestamp,
	/** 耗时（毫秒），按单调时钟算，不受 Agent 系统时间改动的影响。 */
	duration_ms: z.number().int(),
	result: ActionResult,
	/** 失败的原因（最多 4096 个字符）；其他结果为 null。 */
	reason: z.string().nullable(),
});

/** 一种名称（动作和标记的名称在一起）的计数。 */
export const ActionNameCount = z.object({
	name: z.string(),
	/** 动作和标记的个数，不论有没有明细。 */
	total: z.number().int(),
	/** 失败的动作的个数。 */
	failed: z.number().int(),
	/** 有明细的个数；total 减去它是只计数、没有明细的个数。 */
	reported: z.number().int(),
	/** 从什么时候起只计数（控制面时间、Agent 时间）；没有超出上限时为 null。失败的动作超出后仍有明细。 */
	capped_at: Timestamp.nullable(),
	agent_capped_at: Timestamp.nullable(),
});

/**
 * 一个任务的动作摘要：任务结束（成功、失败、取消、`agent_lost`）以后 `running` 为空。
 * 正在做的、最近结束的、计数都只取这一份，超出上限前后都准确。
 */
export const ActionSummaryView = z.object({
	/** 动作和标记合计的个数。 */
	total: z.number().int(),
	/** 有明细的个数（最多 100000）。 */
	reported: z.number().int(),
	/** 有没有超出上限：有动作或标记只计数、没有明细。 */
	capped: z.boolean(),
	/** 合计已满、开始丢弃明细的时刻；没有丢弃过时为 null。不是明细的终点：之后仍可能有补上的失败的动作。 */
	capped_at: Timestamp.nullable(),
	agent_capped_at: Timestamp.nullable(),
	/** 每种名称一项，按第一次出现的先后。 */
	names: z.array(ActionNameCount),
	/** 正在做的动作，最多 50 个（层级浅的优先），按 ID 排列。 */
	running: z.array(RunningActionView),
	/** `running` 是不是全部正在做的动作：列满 50 个时为 false，可能还有没列出的。 */
	running_complete: z.boolean(),
	/** 最近结束的 20 个动作，最近结束的在前。 */
	recent: z.array(EndedActionView),
	/** 最近失败的 5 个动作，最近失败的在前。 */
	recent_failed: z.array(EndedActionView),
});

/**
 * 执行中的任务此刻在做的事：最外层（第 0 层）、开始得最早的那个正在做的动作（运行视图的尝试、
 * Agent 列表里正在执行的任务都带它）。没有正在做的最外层动作、或者任务不在执行中时为 null。
 */
export const CurrentAction = z.object({
	name: z.string(),
	/** 开始的控制面时间。 */
	started_at: Timestamp,
});

export const actionsApi = {
	/** 一个任务（一次尝试）的动作摘要；没有记录过动作的任务返回各项为空的摘要，任务不存在时 404。 */
	summary: endpoint({
		method: "GET",
		path: "/tasks/:id/actions/summary",
		client: true,
		key: ["actions", "summary"],
		params: IdParams,
		response: ActionSummaryView,
	}),
};

export type ActionResult = z.infer<typeof ActionResult>;
export type RunningActionView = z.infer<typeof RunningActionView>;
export type EndedActionView = z.infer<typeof EndedActionView>;
export type ActionNameCount = z.infer<typeof ActionNameCount>;
export type ActionSummaryView = z.infer<typeof ActionSummaryView>;
export type CurrentAction = z.infer<typeof CurrentAction>;
