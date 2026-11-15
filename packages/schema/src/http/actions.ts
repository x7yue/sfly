import { z } from "zod";
import { endpoint, stream, Timestamp } from "./contract.js";

/**
 * 动作与标记的接口（GLOSSARY「动作」「标记」，规格 #345）。节点用 `ctx.action`、`ctx.mark` 记录，SDK 每秒最多发一份
 * 摘要、并逐个写出明细（格式见 sdk/python/src/sfly/context.py），Agent 转发，控制面在任务上只存最新的一份摘要、
 * 按任务存明细（apps/server/src/actions/，docs/ARCHITECTURE.md §6.3）。时间都带两种（ADR 0018）：控制面时间由
 * SDK 写的单调时钟读数折算，Agent 时间原样保存。
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
	/** 其中标记的个数：动作的个数是 total 减去它。 */
	marks: z.number().int(),
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

/** 明细的公共部分：动作和标记都有。 */
const DetailBase = z.object({
	/** 任务内的 ID（动作和标记共用一个序列）。 */
	id: z.number().int(),
	/** 父动作的 ID；最外层为 null。父动作不一定有明细。 */
	parent: z.number().int().nullable(),
	/** 层级：最外层是 0。 */
	depth: z.number().int(),
	name: z.string(),
	/** 说明字段（值都是文字），按写入的先后；动作的是开始时给的加上之后补充的。 */
	fields: z.record(z.string(), z.string()),
	/** 动作开始、标记发生的控制面时间。 */
	started_at: Timestamp,
	agent_started_at: Timestamp,
});

/** 一个标记的明细：只有一个时刻。 */
export const ActionMarkDetail = DetailBase.extend({ kind: z.literal("mark") });

/**
 * 一个动作的明细。还在做时结果和结束都为 null；任务结束（成功、失败、取消、`agent_lost`）时还没结束的记为
 * `unfinished`，结束时间取任务的结束时间。
 */
export const ActionRecordDetail = DetailBase.extend({
	kind: z.literal("action"),
	/** 结果；还在做时为 null。 */
	result: ActionResult.nullable(),
	/** 结束的控制面时间；还在做时为 null。 */
	ended_at: Timestamp.nullable(),
	/** 结束的 Agent 时间；还在做时，以及任务结束时还没结束、取不到 Agent 时间时为 null。 */
	agent_ended_at: Timestamp.nullable(),
	/** 耗时（毫秒）：按单调时钟算，不受 Agent 系统时间改动的影响；记为未结束的按控制面时间算；还在做时为 null。 */
	duration_ms: z.number().int().nullable(),
	/** 失败的原因（最多 4096 个字符）；其他结果为 null。 */
	reason: z.string().nullable(),
});

/** 一条明细：一个动作或一个标记。 */
export const ActionDetailView = z.discriminatedUnion("kind", [
	ActionMarkDetail,
	ActionRecordDetail,
]);

/**
 * 只计数的一段：这段时间里有动作或标记只计数、没有明细。
 *
 * - `name_limit`：这个名称超过了每种名称的上限（5 万个），失败的动作仍有明细，不在 `count` 里；
 * - `total_limit`：合计超过了上限（10 万个），之后所有名称都只计数，失败的也是；
 * - `control_plane`：控制面兜底丢弃（被改过的 SDK 写出了超过上限的明细）。
 *
 * 每种名称、每种原因至多一段；算法见 docs/ARCHITECTURE.md §6.3。
 */
export const CountOnlyPeriod = z.object({
	name: z.string(),
	reason: z.enum(["name_limit", "total_limit", "control_plane"]),
	/** 从什么时候起（控制面时间、Agent 时间）：第一个没有明细的动作或标记的时刻。 */
	from: Timestamp,
	agent_from: Timestamp,
	/** 到什么时候：任务已结束时是任务的结束时间；还在执行时为 null（至今）。 */
	to: Timestamp.nullable(),
	/** 这一段里没有明细的个数。 */
	count: z.number().int(),
});

/** 明细的分页游标：不透明字符串，由上一页的 `before` 原样传回。 */
const ActionCursor = z.string();

/** 查询参数：空字符串等于没给。 */
const blankAsMissing = <S extends z.ZodType>(schema: S) =>
	z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

/** 一页最多的明细数。 */
export const MAX_ACTION_PAGE = 500;

export const ActionPageQuery = z.object({
	/** 读这个游标之前（更早开始）的明细；不给时读最新的一页。 */
	before: blankAsMissing(ActionCursor),
	limit: z.coerce.number().int().min(1).max(MAX_ACTION_PAGE).default(100),
	/** 只要这个名称的。 */
	name: blankAsMissing(z.string()),
	/** true：只要失败的动作（没有标记）。 */
	failed: blankAsMissing(z.stringbool()),
});

/**
 * 一个任务（一次尝试）的一页明细，按开始时间从新到旧（开始时间相同时 ID 大的在前）。
 *
 * 一页的范围：从这一页最早的那条明细（读到最早一页时是任务的开头）到游标（最新一页时是现在），`count_only`
 * 是起点（`from`）落在这个范围里的只计数的段，所以一直往前翻，每一段正好出现一次。
 */
export const ActionPage = z.object({
	task_id: z.string(),
	actions: z.array(ActionDetailView),
	/** 读更早的一页：下一次请求的 before；没有更早的明细时为 null。 */
	before: ActionCursor.nullable(),
	/**
	 * 起点落在这一页范围里的只计数的段，从新到旧。只看失败时，`name_limit` 的段只在合计也满了时才有：合计没满时，
	 * 超过每种名称上限之后失败的动作仍有明细。
	 */
	count_only: z.array(CountOnlyPeriod),
	/**
	 * 读这一页那一刻明细的修订号：实时推送（`events`）的 `after` 用它，之后写入或结束的明细都由推送送达。
	 * 最新一页的这个值才有用。
	 */
	rev: z.number().int(),
	/** 运行已超过保留期、明细已被清理（此时是空页）。 */
	expired: z.boolean(),
});

/** 实时推送的一批新写入或刚结束的明细（`events` 的 `actions` 事件）。同一个 ID 再出现时，以后到的为准。 */
export const ActionChunk = z.object({
	actions: z.array(ActionDetailView),
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
	/**
	 * 一个任务（一次尝试）的明细，按开始时间从新到旧分页，可以按名称、只看失败筛选；返回落在这一页范围里的只计数的段。
	 * 任务不存在时 404，游标不是之前返回的 `before` 时 400。
	 */
	page: endpoint({
		method: "GET",
		path: "/tasks/:id/actions",
		client: true,
		key: ["actions", "page"],
		params: IdParams,
		query: ActionPageQuery,
		response: ActionPage,
	}),
	/**
	 * 摘要和明细的实时推送（SSE）。`after` 用分页返回的 `rev`；断线重连时按 `Last-Event-ID` 请求头接上
	 * （与 `after` 取较大者，API 客户端的订阅自动带上），不重复也不遗漏。
	 *
	 * - `summary`：连上时先发一份，之后每存下一份新的摘要发一份；任务结束时再发一份（正在做的动作为空）。
	 * - `actions`：`after` 之后写入或结束的明细，之后每写入一批推送一批；任务结束时推送记为未结束的那些。
	 *
	 * 事件 ID 是推送到的修订号。运行已过保留期时只发摘要。任务不存在时 404。
	 */
	events: stream({
		path: "/tasks/:id/actions/events",
		client: true,
		params: IdParams,
		query: z.object({ after: blankAsMissing(z.coerce.number().int().min(0)) }),
		events: { summary: ActionSummaryView, actions: ActionChunk },
	}),
};

export type ActionResult = z.infer<typeof ActionResult>;
export type RunningActionView = z.infer<typeof RunningActionView>;
export type EndedActionView = z.infer<typeof EndedActionView>;
export type ActionNameCount = z.infer<typeof ActionNameCount>;
export type ActionSummaryView = z.infer<typeof ActionSummaryView>;
export type CurrentAction = z.infer<typeof CurrentAction>;
export type ActionMarkDetail = z.infer<typeof ActionMarkDetail>;
export type ActionRecordDetail = z.infer<typeof ActionRecordDetail>;
export type ActionDetailView = z.infer<typeof ActionDetailView>;
export type CountOnlyPeriod = z.infer<typeof CountOnlyPeriod>;
export type ActionPage = z.infer<typeof ActionPage>;
export type ActionChunk = z.infer<typeof ActionChunk>;
