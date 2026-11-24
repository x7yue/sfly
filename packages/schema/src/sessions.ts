import { z } from "zod";
import { Timestamp } from "./http/contract.js";

/**
 * 助手会话的类型（GLOSSARY「助手」一节，ADR 0027）：平台的**会话事件**（控制面、助手服务、页面之间唯一的形状，
 * 不引用 pi 的任何类型），和会话接口的请求、响应。只有 zod schema 和类型，没有 `endpoint()`、`stream()`：
 * 接口定义、资源类别 `session`、路由和表随控制面的会话模块一起加（#541）。
 *
 * 取值（事件的 `type`、`outcome`、`kind`、`error_class`，会话的状态，就绪问题的种类）在这里一次定全：
 * 响应里的枚举多一个值、事件改名都算 API 客户端的不兼容变化（docs/agents/branching-and-release.md「PR」一节），
 * 后面的任务只是开始产生已有的取值，不再加值。每个取值由哪条任务开始产生，写在各自的注释里。
 *
 * 助手服务和控制面之间的命令与事件流（不进控制面的 HTTP 契约）在 assistant-protocol.ts。
 */

/** 会话 ID：UUID。助手服务拿它给 pi 的会话文件命名，所以协议里就限定成 UUID，不会带出路径。 */
export const SessionId = z.uuid();
export type SessionId = z.infer<typeof SessionId>;

/** 会话里一句话（新建、发话、插话）的长度上限（字符数）。 */
export const SESSION_MESSAGE_MAX_CHARS = 20_000;

/**
 * 事件里各段文字的截断上限（字节）：产生事件的一方先截断再发，这里不拒绝超长的值（拒绝就丢掉整条事件）。
 * 工具调用的 `title` 超过上限截断；工具结果的 `text`、`diff` 超过上限只留头尾并标 `truncated`。
 */
export const SESSION_EVENT_LIMITS = {
	/** `tool_call.title`：命令原文或文件路径。 */
	toolTitleBytes: 2 * 1024,
	/** `tool_result.text` 和 `tool_result.diff`。 */
	toolResultBytes: 16 * 1024,
	/** `platform`（`commit`）的差异。 */
	commitDiffBytes: 64 * 1024,
	/** `snapshot.running_tool.output`：在跑的工具已经输出的最后一段。 */
	runningToolOutputBytes: 16 * 1024,
} as const;

/** `GET /sessions/:id` 一次最多返回的持久事件条数。 */
export const SESSION_HISTORY_PAGE = 200;

/**
 * `GET /projects/:project/sessions` 最多返回的会话个数：在做和排队中的在前，其余按最近活动倒序，超出的更早的会话不返回
 * （页面上没有「更多」之前，一个项目的会话数不会多到这里；翻页在会话的删除和保留期那一步做）。
 */
export const SESSION_LIST_LIMIT = 200;

/**
 * 会话内序号 `seq` 的上限：PostgreSQL `integer`（int4）的最大值。`before`、`after` 和 `Last-Event-ID` 超过它的，
 * 契约直接 400（或当作不是数字），不会走到库里的 `integer` 比较去 500。一个会话写满这么多条事件要很久很久，
 * 到了就是到了。
 */
export const SESSION_SEQ_MAX = 2_147_483_647;

// ---------------------------------------------------------------------------
// 枚举
// ---------------------------------------------------------------------------

/**
 * 助手能用的工具：读、写、编辑文件，执行命令（`command`）。文件和命令都落在工作台上。取值是平台的叫法，不是 pi 的工具名：
 * 换 pi 或换嵌入方式时它不跟着变（助手服务把 pi 的工具名翻成它们）。
 */
export const SessionTool = z.enum(["read", "write", "edit", "command"]);
export type SessionTool = z.infer<typeof SessionTool>;

/**
 * 一轮（GLOSSARY「一轮」）的结局，`turn_end.outcome` 和会话的 `last_turn_outcome`：
 * - `completed` 完成：pi 报告 `agent_settled`；
 * - `stopped` 已停止：用户停止；
 * - `limit` 到了上限：一轮的模型调用次数或用时用完（哪一种见 `turn_end.limit_kind`，{@link TurnLimit}；默认 40 次模型调用、
 *   20 分钟，#540）；
 * - `model_unavailable` 模型不可用：模型没有配置或连不上，带 `error_class`（#640 起按下面 {@link ErrorClass} 的规则分）；
 * - `interrupted` 中断：pi 进程在这一轮里退出了；助手服务重启了，由控制面补一条（#545）；
 * - `failed` 其他错误。
 * 产生：助手服务从 #540 起产生全部六种；控制面也会写：补的 `interrupted`（助手服务重启了，#545）和 `failed`
 * （助手服务同时在做的会话太多，进程数满了，#545）。
 */
export const TurnOutcome = z.enum([
	"completed",
	"stopped",
	"limit",
	"model_unavailable",
	"interrupted",
	"failed",
]);
export type TurnOutcome = z.infer<typeof TurnOutcome>;

/** 一轮到了哪一种上限（`turn_end.limit_kind`，`outcome` 为 `limit` 时给出）：`model_calls` 模型调用次数，`duration` 用时。#540 起。 */
export const TurnLimit = z.enum(["model_calls", "duration"]);
export type TurnLimit = z.infer<typeof TurnLimit>;

/**
 * 模型一类的故障按什么分（`notice.error_class`、`turn_end.error_class`）。#640 起助手服务按上游的错误分好再写（`turn_end`
 * 模型不可用时、重试的 `notice`），上游的错误原文不进事件，只进助手服务的日志。落库之后改不了，所以宁可分到 `other`，
 * 不能分错：
 * - 状态码只从结构上取：pi 只给一句话，只认这句话开头的固定写法（`502: …`、`<提供方> API error (502): …`、SDK 的
 *   `502 …`），不在全文里找；取不到就是没有状态码。
 * - 有状态码时由它定类别，正文里的词只能在这个范围里细分：401、403 是 `auth`（正文说额度时是 `quota`）；402 是 `quota`；
 *   429 是 `rate_limit`（正文说额度时是 `quota`）；408、504 是 `timeout`；其余 5xx 是 `upstream`；其余 4xx 是 `other`
 *   （上游拒绝了这次请求；正文说上下文超长时是 `context_overflow`）。
 * - 没有状态码时只按连接层的失败分：连不上、连接断开、证书验不过是 `unreachable`，超时是 `timeout`（认 Node 的错误码、
 *   SDK 固定的那一句），别的都是 `other`；不看正文里的词。
 * - 边界（按写法认，不看意思）：以登记过的状态码加空格开头的消息按 SDK 的写法取状态码，所以正文恰好以这样的数字开头的错误
 *   （`404 packages were …`）会被认成那个状态码；没有状态码时，以括号里的连接层错误码结尾的消息（`… (ECONNRESET)`）算连不上。
 * 各项：`unreachable` 连不上或连接断开，`timeout` 超时，`auth` 密钥被拒绝，`quota` 额度不足，`rate_limit` 限流，
 * `upstream` 对方出错，`context_overflow` 上下文超长，`other` 其他。
 */
export const ErrorClass = z.enum([
	"unreachable",
	"timeout",
	"auth",
	"quota",
	"rate_limit",
	"upstream",
	"context_overflow",
	"other",
]);
export type ErrorClass = z.infer<typeof ErrorClass>;

/**
 * 提示（`notice`）的种类。助手服务产生的：`retry` 正在重试、`retry_end` 重试结束、`compaction` 压缩了上下文、
 * `steer_dropped` 插话没有送到模型（停止、到了上限、结束会话时还没送到，或者这一轮因为别的原因结束了；每句各一条，**必须带**这句话的
 * `message_id`；插话命令回 409 或者没有得到 202、控制面自己补这一轮的结局时，没有确认送到的话的 `steer_dropped` 由控制面写，规则见
 * 助手服务协议「插话」一节）、`context_reset` 接不上之前的上下文，换成了一段摘要；
 * 控制面产生的：`queue_cancelled` 排队中的话因停止没有交给助手（**必须带**这句话的 `message_id`；`message` 固定写「这句话排队时被取消了，
 * 没有交给助手」）、`events_lost` 控制面和助手服务断开太久，这一段过程没有记下。
 * 产生：`retry`、`retry_end`、`compaction` #540；`steer_dropped`、`queue_cancelled` #544；
 * `events_lost`、`context_reset` #545。
 */
export const NoticeKind = z.enum([
	"retry",
	"retry_end",
	"compaction",
	"steer_dropped",
	"queue_cancelled",
	"events_lost",
	"context_reset",
]);
export type NoticeKind = z.infer<typeof NoticeKind>;

/** {@link NoticeKind} 里由助手服务产生的几种（其余由控制面产生）。 */
export const AssistantNoticeKind = NoticeKind.extract([
	"retry",
	"retry_end",
	"compaction",
	"steer_dropped",
	"context_reset",
]);
export type AssistantNoticeKind = z.infer<typeof AssistantNoticeKind>;

/**
 * `platform` 事件的种类：平台在会话里留下的东西。`commit` 一轮结束时工作区的提交（助手服务提交后发出，#546）；
 * `scenario_version` 助手保存了场景的一个版本，`run` 助手触发了一次运行（这两种由控制面在记下那条记录的
 * 同一个事务里写，#547）。
 */
export const PlatformEventKind = z.enum(["commit", "scenario_version", "run"]);
export type PlatformEventKind = z.infer<typeof PlatformEventKind>;

/**
 * 会话的状态：`idle` 空闲、`running` 在做（有一轮在进行）、`queued` 排队中（同一个项目另一个会话在做，#544）、
 * `ended` 已结束。
 */
export const SessionStatus = z.enum(["idle", "running", "queued", "ended"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

/**
 * 助手此刻不能用的原因的种类（{@link Readiness}）：`assistant_not_configured` 控制面没有配置助手服务，
 * `assistant_unreachable` 助手服务连不上，`workbench_not_set` 项目没有设置工作台，`workbench_offline` 工作台的
 * Agent 不在线，`model_not_configured` 助手容器里没有配置模型，`model_unreachable` 模型连不上。
 * 产生：`assistant_*` 和 `workbench_*` 四种 #541（`workbench_*` 从 #549 起按项目的工作台登记判断），模型的两种 #548。
 */
export const ReadinessProblemKind = z.enum([
	"assistant_not_configured",
	"assistant_unreachable",
	"workbench_not_set",
	"workbench_offline",
	"model_not_configured",
	"model_unreachable",
]);
export type ReadinessProblemKind = z.infer<typeof ReadinessProblemKind>;

/**
 * 会话接口的错误码（`ApiErrorBody.error.code`）：
 * - 503 `assistant_not_configured`：助手没有配置，写接口返回它（读接口照常，就绪状态里写明）；
 * - 503 `assistant_unavailable`：助手服务连不上；
 * - 503 `model_unavailable`：模型没有配置或连不上，新的一轮在开始之前被拒绝（#548）；
 * - 409 `turn_running`：这个会话有一轮在做时发话，409 `project_busy`：同一个项目另一个会话在做（竖切里有，
 *   #544 改成插话和排队，这两个码随之不再出现）；
 * - 409 `session_queued`：排队中再发话（#544）；409 `session_ended`：会话已结束；
 * - 409 `session_predates_login`：这个会话建于登录之前（没有发起人的用户），签发不了会话令牌，要新建一个会话（#547）。
 */
export const SessionErrorCode = z.enum([
	"assistant_not_configured",
	"assistant_unavailable",
	"model_unavailable",
	"turn_running",
	"project_busy",
	"session_queued",
	"session_ended",
	"session_predates_login",
]);
export type SessionErrorCode = z.infer<typeof SessionErrorCode>;

// ---------------------------------------------------------------------------
// 会话事件
// ---------------------------------------------------------------------------

/**
 * 会话事件的类型（`type`）。顺序按一轮里出现的先后。事件分两类：
 * - **持久**的，{@link PERSISTED_SESSION_EVENT_TYPES}：控制面落库时给一个会话内序号 `seq`（从 1 起），另有时间 `at`：
 *   **`at` 是事件产生的时间，不是落库的时间**——助手服务产生的事件由它盖时间（`AssistantStreamRecord.at`），控制面原样存；
 *   控制面自己产生的（用户的话、平台记录、它补的 `turn_end`）用控制面的时钟。控制面重启后补收的事件，时间才不会整体偏后，
 *   时间线上的先后和耗时才对。两个容器通常在同一台主机上，时钟的偏差接受。SSE 用 `seq` 作事件 ID，页面刷新后从库里读回；
 * - 其余只推不存：没有 `seq`，浏览器断线重连后用 `snapshot` 补上当时的状态。
 */
export const SESSION_EVENT_TYPES = [
	"user_message",
	"turn_started",
	"turn_queued",
	"thinking",
	"assistant_delta",
	"assistant_message",
	"tool_call",
	"tool_output",
	"tool_result",
	"steer_queue",
	"notice",
	"turn_end",
	"platform",
	"session_ended",
	"snapshot",
] as const;
export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];

/** 持久的事件类型：控制面写进 `session_events` 的那几类（其余只推不存）。 */
export const PERSISTED_SESSION_EVENT_TYPES = [
	"user_message",
	"turn_started",
	"assistant_message",
	"tool_call",
	"tool_result",
	"notice",
	"turn_end",
	"platform",
	"session_ended",
] as const satisfies readonly SessionEventType[];
export type PersistedSessionEventType = (typeof PERSISTED_SESSION_EVENT_TYPES)[number];

/** 一次模型调用（或一轮合计）用的 token：输入、输出、缓存读、缓存写。 */
export const TokenUsage = z.object({
	input: z.int().min(0),
	output: z.int().min(0),
	cache_read: z.int().min(0),
	cache_write: z.int().min(0),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

/**
 * 用户说了一句话。控制面收到这句话时产生。`message_id` 是这句话自己的 ID（控制面收到时分配）：插话队列
 * （{@link SteerQueueEvent}）和插话命令都带它，连发两句相同的话也分得清。`steer` 为 true 是插话（助手正在做时发的，#544）。
 * `author` 是说这句话的人的昵称，`author_user_id` 是他的用户 ID（#547 起有值，在那之前为 null）。
 * 持久。#541 起。
 */
export const UserMessageEvent = z.object({
	type: z.literal("user_message"),
	message_id: z.uuid(),
	text: z.string(),
	steer: z.boolean(),
	author: z.string(),
	author_user_id: z.string().nullable(),
});

/** 控制面把一轮交给助手服务时产生。`turn` 是会话里第几轮（从 1 起）。持久。#541 起。 */
export const TurnStartedEvent = z.object({
	type: z.literal("turn_started"),
	turn: z.int().min(1),
});

/** 排队的会话在等谁：正在做的那个会话，它的标题和发起人（昵称）。 */
export const WaitingFor = z.object({
	session_id: SessionId,
	title: z.string(),
	created_by: z.string(),
});
export type WaitingFor = z.infer<typeof WaitingFor>;

/**
 * 这个会话在排队：同一个项目同一时刻只跑一轮，另一个会话在做。控制面产生。`position` 从 1 起，
 * `waiting_for` 是正在做的那个会话。不存：排队的状态记在会话的 `status`、`queue_position` 上，在等谁也在会话视图
 * （{@link SessionView}）和快照（{@link SnapshotEvent}）里，刷新页面后拿得回来。#544 起。
 */
export const TurnQueuedEvent = z.object({
	type: z.literal("turn_queued"),
	position: z.int().min(1),
	waiting_for: WaitingFor,
});

/** 模型在思考（不带思考的内容）。助手服务产生，对应 pi 的 `thinking_start`、`thinking_delta`。不存。#540 起。 */
export const ThinkingEvent = z.object({
	type: z.literal("thinking"),
});

/** 助手正在输出的那条消息的增量文字。助手服务产生，对应 pi 的 `text_delta`。不存。#540 起。 */
export const AssistantDeltaEvent = z.object({
	type: z.literal("assistant_delta"),
	text: z.string(),
});

/**
 * 助手的一条完整消息，以 pi 的 `message_end` 为准；`usage` 是这次模型调用用的 token。
 * 助手服务产生。持久。#540 起。
 */
export const AssistantMessageEvent = z.object({
	type: z.literal("assistant_message"),
	text: z.string(),
	usage: TokenUsage,
});

/**
 * 助手调用了一个工具（对应 pi 的 `tool_execution_start`）。`call_id` 把它和之后的 `tool_output`、`tool_result`
 * 连起来；`title` 是命令原文或文件路径，超过 {@link SESSION_EVENT_LIMITS} 的 `toolTitleBytes` 截断。
 * 助手服务产生。持久。#540 起。
 */
export const ToolCallEvent = z.object({
	type: z.literal("tool_call"),
	call_id: z.string().min(1),
	tool: SessionTool,
	title: z.string(),
});

/** 工具执行中输出的增量文字（对应 pi 的 `tool_execution_update`）。助手服务产生。不存。#540 起。 */
export const ToolOutputEvent = z.object({
	type: z.literal("tool_output"),
	call_id: z.string().min(1),
	text: z.string(),
});

/**
 * 工具的结果（对应 pi 的 `tool_execution_end`）。`text` 是模型看到的那份结果；`exit_code` 只有命令才有
 * （拿不到退出码时不给）；`diff` 只有编辑才有，取 pi 结果里的 `details.diff`。`text` 和 `diff` 超过
 * {@link SESSION_EVENT_LIMITS} 的 `toolResultBytes` 只留头尾，`truncated` 标出（任何一段被截断都为 true；pi 自己截断过的
 * 结果也为 true：命令的输出只留了末尾、读文件只给了一部分，模型看到的就不是全部）。**命令超时这一种不标 pi 的截断**：pi 把超时
 * 包成一个没有细节（`details`）的错误结果，助手服务看不出它截断过，只有 `text` 自己超过上限时才是 true（#618 审查，#544 收）。
 * 助手服务产生。持久。#540 起。
 */
export const ToolResultEvent = z.object({
	type: z.literal("tool_result"),
	call_id: z.string().min(1),
	is_error: z.boolean(),
	text: z.string(),
	truncated: z.boolean(),
	exit_code: z.int().optional(),
	diff: z.string().optional(),
	duration_ms: z.int().min(0),
});

/** 插话队列里的一条：用户这句话的 ID（`user_message.message_id`）和文字。 */
export const SteerEntry = z.object({
	message_id: z.uuid(),
	text: z.string(),
});
export type SteerEntry = z.infer<typeof SteerEntry>;

/**
 * 还没送到模型的插话，完整列表（每次变化都发一条，取代上一条）：每条带自己的 `message_id`，不靠文字对应。
 * 助手服务产生，对应 pi 的 `queue_update` 的 `steering`。不存。#544 起。
 */
export const SteerQueueEvent = z.object({
	type: z.literal("steer_queue"),
	messages: z.array(SteerEntry),
});

/**
 * 提示给人看的一句话的公共部分，见 {@link NoticeKind}：重试才有 `attempt`、`max_attempts`、`retry_delay_ms`、
 * `error_class`；`steer_dropped`、`queue_cancelled` 才有 `message_id`，而且这两种**必须带**（{@link checkNoticeMessageId}）。
 */
const noticeFields = {
	type: z.literal("notice"),
	/** 给人看的一句话。 */
	message: z.string(),
	/** 第几次重试（从 1 起）；只有 `retry`。 */
	attempt: z.int().min(1).optional(),
	/** 最多重试几次；只有 `retry`。 */
	max_attempts: z.int().min(1).optional(),
	/** 多久（毫秒）之后重试；只有 `retry`。 */
	retry_delay_ms: z.int().min(0).optional(),
	/** 重试的原因按什么分（#640 起有值）。 */
	error_class: ErrorClass.optional(),
	/**
	 * 没有送到的那句话（`user_message.message_id`）：`steer_dropped`（插话没有送到模型）和 `queue_cancelled`（排队中的话因停止没有交给助手）
	 * **必须带**，其余种类不能带。页面据此把这一行和那句话对上，不靠 `message` 里引用的文字；同一句话可能有两条 `steer_dropped`
	 * （控制面写了「没有确认送到」、助手服务之后又确认没送到），按它认，显示一次。#544 起。
	 */
	message_id: z.uuid().optional(),
};

/**
 * `message_id` 的规则：`steer_dropped`、`queue_cancelled` 必须带，其余种类不能带。写在 schema 里，助手服务那一半漏写、
 * 或者控制面给不该带的种类带上，测试和解析都会失败。
 */
function checkNoticeMessageId(
	notice: { kind: NoticeKind; message_id?: string | undefined },
	ctx: z.RefinementCtx,
): void {
	const needs = notice.kind === "steer_dropped" || notice.kind === "queue_cancelled";
	if (needs && notice.message_id === undefined) {
		ctx.addIssue({
			code: "custom",
			path: ["message_id"],
			message: `${notice.kind} 要带 message_id（没有送到的那句话）`,
		});
	}
	if (!needs && notice.message_id !== undefined) {
		ctx.addIssue({
			code: "custom",
			path: ["message_id"],
			message: "只有 steer_dropped、queue_cancelled 带 message_id",
		});
	}
}

/**
 * 一条提示。持久。`queue_cancelled`、`events_lost` 由控制面产生，其余由助手服务产生（助手服务只产生
 * {@link AssistantNoticeEvent} 那几种）。
 */
const noticeObject = z.object({ kind: NoticeKind, ...noticeFields });
export const NoticeEvent = noticeObject.superRefine(checkNoticeMessageId);

/** 助手服务产生的提示：{@link NoticeEvent} 里 `kind` 限定在 {@link AssistantNoticeKind}。 */
export const AssistantNoticeEvent = z
	.object({ kind: AssistantNoticeKind, ...noticeFields })
	.superRefine(checkNoticeMessageId);

/**
 * 一轮结束（对应 pi 的 `agent_settled`、pi 进程退出、到了上限、模型错误），结局见 {@link TurnOutcome}。
 * `reason` 是一句话；`steps` 是工具调用次数，`model_calls` 是模型调用次数，`usage` 是这一轮合计：
 * 控制面补的 `interrupted`（助手服务重启了，#545）拿不到这三项，不给。`duration_ms` 是这一轮用的时间。
 * `limit_kind` 在 `outcome` 为 `limit` 时给出，是哪一种上限（{@link TurnLimit}），不靠 `reason` 的文字；
 * `error_class` 在模型不可用时给出（#640 起按类别分）。`reason` 不带「模型不可用」这几个字，页面按结局加。助手服务产生（控制面也会写 `interrupted`、
 * `failed` 的，#545），持久。#540 起。
 */
export const TurnEndEvent = z.object({
	type: z.literal("turn_end"),
	turn: z.int().min(1),
	outcome: TurnOutcome,
	reason: z.string(),
	steps: z.int().min(0).optional(),
	model_calls: z.int().min(0).optional(),
	duration_ms: z.int().min(0),
	usage: TokenUsage.optional(),
	limit_kind: TurnLimit.optional(),
	error_class: ErrorClass.optional(),
});

/** 提交里一个文件的改动；`additions`、`deletions` 是增、删的行数，二进制文件为 null。 */
export const CommitFile = z.object({
	path: z.string(),
	additions: z.int().min(0).nullable(),
	deletions: z.int().min(0).nullable(),
});
export type CommitFile = z.infer<typeof CommitFile>;

/**
 * 一轮结束时工作区的提交：提交号 `hash`、改了哪些文件、差异（超过 {@link SESSION_EVENT_LIMITS} 的
 * `commitDiffBytes` 只留头部，`truncated` 标出）。`turn` 是这个提交属于第几轮（被打断那一轮的补提交在下一轮的事件流里
 * 发出，靠时间线上的位置推不准）。助手服务提交后发出。持久。#546 起。
 */
export const PlatformCommitEvent = z.object({
	type: z.literal("platform"),
	kind: z.literal("commit"),
	turn: z.int().min(1),
	hash: z.string().min(1),
	files: z.array(CommitFile),
	diff: z.string(),
	truncated: z.boolean(),
});

/** 助手保存了场景的一个版本，`turn` 是第几轮。控制面在记下那条记录的同一个事务里写。持久。#547 起。 */
export const PlatformScenarioVersionEvent = z.object({
	type: z.literal("platform"),
	kind: z.literal("scenario_version"),
	turn: z.int().min(1),
	scenario_id: z.uuid(),
	name: z.string(),
	version: z.int().min(1),
});

/** 助手触发了一次运行，`turn` 是第几轮。控制面在记下那条记录的同一个事务里写。持久。#547 起。 */
export const PlatformRunEvent = z.object({
	type: z.literal("platform"),
	kind: z.literal("run"),
	turn: z.int().min(1),
	run_id: z.uuid(),
	scenario_name: z.string(),
});

/** 平台在会话里留下的东西（按 `kind` 区分，见 {@link PlatformEventKind}）。持久。 */
export const PlatformEvent = z.discriminatedUnion("kind", [
	PlatformCommitEvent,
	PlatformScenarioVersionEvent,
	PlatformRunEvent,
]);

/** 会话结束，`by` 是结束它的人的昵称。控制面产生。持久。#544 起。 */
export const SessionEndedEvent = z.object({
	type: z.literal("session_ended"),
	by: z.string(),
});

/** 助手正在跑的一次工具调用，和它已经输出的最后一段（至多 `runningToolOutputBytes`）。 */
export const RunningTool = z.object({
	call_id: z.string().min(1),
	tool: SessionTool,
	title: z.string(),
	output: z.string(),
});
export type RunningTool = z.infer<typeof RunningTool>;

/**
 * 会话此刻的状态：控制面在浏览器刚连上事件流时，只发给这一条连接，让断线期间错过的增量不用补发
 * （`partial_text` 是正在输出的那条助手消息已有的文字，没有时为空字符串；`running_tool` 没有在跑的工具时为 null；
 * `steer_queue` 是还没送到模型的插话；`waiting_for` 是排队中在等谁，不在排队时为 null）。不存。#545 起（`waiting_for` #544）。
 */
export const SnapshotEvent = z.object({
	type: z.literal("snapshot"),
	status: SessionStatus,
	partial_text: z.string(),
	running_tool: RunningTool.nullable(),
	steer_queue: z.array(SteerEntry),
	waiting_for: WaitingFor.nullable(),
});

/**
 * 会话事件的**内容**（产生事件的一方——助手服务或控制面——写的形状，没有 `seq`、`at`）：按 `type` 区分的联合类型。
 * 读事件的一方（页面、接口的响应）看到的是 {@link SessionEvent}，持久的那几种多了 `seq`、`at`。
 */
export const SessionEventBody = z.discriminatedUnion("type", [
	UserMessageEvent,
	TurnStartedEvent,
	TurnQueuedEvent,
	ThinkingEvent,
	AssistantDeltaEvent,
	AssistantMessageEvent,
	ToolCallEvent,
	ToolOutputEvent,
	ToolResultEvent,
	SteerQueueEvent,
	NoticeEvent,
	TurnEndEvent,
	PlatformEvent,
	SessionEndedEvent,
	SnapshotEvent,
]);
export type SessionEventBody = z.infer<typeof SessionEventBody>;

/**
 * 持久的事件落库后多出的两个字段：会话内序号（从 1 起，SSE 的事件 ID，上限 {@link SESSION_SEQ_MAX}）和事件产生的时间
 * （不是落库的时间：助手服务产生的事件由它盖时间，控制面原样存，见 {@link SESSION_EVENT_TYPES}）。
 */
const persisted = {
	seq: z.int().min(1).max(SESSION_SEQ_MAX),
	at: Timestamp,
};

/** `platform` 事件读的一方看到的形状：按 `kind` 区分，三种都是持久的，带 `seq` 和 `at`。 */
const PlatformEventItem = z.discriminatedUnion("kind", [
	PlatformCommitEvent.extend(persisted),
	PlatformScenarioVersionEvent.extend(persisted),
	PlatformRunEvent.extend(persisted),
]);

/**
 * 每种会话事件读的一方看到的形状，以 `type` 为键：持久的（{@link PERSISTED_SESSION_EVENT_TYPES}）带 `seq` 和 `at`，
 * 其余和 {@link SessionEventBody} 里的一样。SSE 的事件名是 `type`，所以接口定义（`stream()` 的 `events`，#541）
 * 直接用这张表：键是事件名，值是这个事件的数据。{@link SessionEvent}、{@link PersistedSessionEvent} 都由它组成。
 */
export const sessionEventSchemas = {
	user_message: UserMessageEvent.extend(persisted),
	turn_started: TurnStartedEvent.extend(persisted),
	turn_queued: TurnQueuedEvent,
	thinking: ThinkingEvent,
	assistant_delta: AssistantDeltaEvent,
	assistant_message: AssistantMessageEvent.extend(persisted),
	tool_call: ToolCallEvent.extend(persisted),
	tool_output: ToolOutputEvent,
	tool_result: ToolResultEvent.extend(persisted),
	steer_queue: SteerQueueEvent,
	notice: noticeObject.extend(persisted).superRefine(checkNoticeMessageId),
	turn_end: TurnEndEvent.extend(persisted),
	platform: PlatformEventItem,
	session_ended: SessionEndedEvent.extend(persisted),
	snapshot: SnapshotEvent,
} as const satisfies Record<SessionEventType, z.ZodType>;

/** 一个持久的会话事件：{@link PERSISTED_SESSION_EVENT_TYPES} 里的类型，带 `seq` 和 `at`（历史接口返回它）。 */
export const PersistedSessionEvent = z.discriminatedUnion("type", [
	sessionEventSchemas.user_message,
	sessionEventSchemas.turn_started,
	sessionEventSchemas.assistant_message,
	sessionEventSchemas.tool_call,
	sessionEventSchemas.tool_result,
	sessionEventSchemas.notice,
	sessionEventSchemas.turn_end,
	sessionEventSchemas.platform,
	sessionEventSchemas.session_ended,
]);
export type PersistedSessionEvent = z.infer<typeof PersistedSessionEvent>;

/**
 * 会话事件（`GET /sessions/:id/events` 推送的、页面处理的形状）：按 `type` 区分的联合类型。持久的事件带
 * `seq` 和 `at`，不存的没有。SSE 的事件名是 `type`，持久的以 `seq` 作事件 ID。
 */
export const SessionEvent = z.discriminatedUnion("type", [
	sessionEventSchemas.user_message,
	sessionEventSchemas.turn_started,
	sessionEventSchemas.turn_queued,
	sessionEventSchemas.thinking,
	sessionEventSchemas.assistant_delta,
	sessionEventSchemas.assistant_message,
	sessionEventSchemas.tool_call,
	sessionEventSchemas.tool_output,
	sessionEventSchemas.tool_result,
	sessionEventSchemas.steer_queue,
	sessionEventSchemas.notice,
	sessionEventSchemas.turn_end,
	sessionEventSchemas.platform,
	sessionEventSchemas.session_ended,
	sessionEventSchemas.snapshot,
]);
export type SessionEvent = z.infer<typeof SessionEvent>;

// ---------------------------------------------------------------------------
// 会话接口的请求和响应（接口定义随 #541 写，这里是规格）
// ---------------------------------------------------------------------------

/** 会话里的一句话：新建会话的第一句、发话、插话。非空（不能只有空白），不超过 {@link SESSION_MESSAGE_MAX_CHARS} 个字符。 */
export const SessionMessageText = z
	.string()
	.min(1, "不能为空")
	.max(SESSION_MESSAGE_MAX_CHARS, `不能超过 ${SESSION_MESSAGE_MAX_CHARS} 个字符`)
	.refine((text) => text.trim().length > 0, "不能只有空白")
	// 会存进数据库的 jsonb：NUL 和不成对的代理字符（`\ud800` 这类）它拒收。挡在写之前，不能等到改了状态再失败。
	.refine((text) => !text.includes("\u0000"), "不能含 NUL 字符")
	.refine((text) => !/\p{Surrogate}/u.test(text), "不能含不成对的代理字符");

/** `POST /projects/:project/sessions`：新建会话，`text` 是它的第一句话，作为第一轮。 */
export const CreateSessionBody = z.object({ text: SessionMessageText });
export type CreateSessionBody = z.infer<typeof CreateSessionBody>;

/** `POST /sessions/:id/messages`：对会话说一句话（空闲时开始新的一轮，在做时是插话）。 */
export const SendMessageBody = z.object({ text: SessionMessageText });
export type SendMessageBody = z.infer<typeof SendMessageBody>;

/** 发话的结果：这句话的 `user_message` 的序号。 */
export const SendMessageResult = z.object({ seq: z.int().min(1) });
export type SendMessageResult = z.infer<typeof SendMessageResult>;

/** 助手此刻不能用的一个原因：种类加一句给人看的话。 */
export const ReadinessProblem = z.object({
	kind: ReadinessProblemKind,
	message: z.string(),
});
export type ReadinessProblem = z.infer<typeof ReadinessProblem>;

/**
 * 助手此刻能不能用：`ready` 为 true 当且仅当 `problems` 为空，否则列出全部原因。`workbench` 是配置的工作台（Agent 的名字），
 * 没有设置时为 null：页面据此写「可以用 · 工作台 X 在线」，工作台不在线时也能写出是哪一台。
 */
export const Readiness = z
	.object({
		ready: z.boolean(),
		problems: z.array(ReadinessProblem),
		workbench: z.string().nullable(),
	})
	.refine((r) => r.ready === (r.problems.length === 0), "ready 为 true 当且仅当没有 problems");
export type Readiness = z.infer<typeof Readiness>;

/**
 * 运行、场景版本上的「经哪个会话」（ADR 0029「经 …」：会话令牌记会话，#547）：会话的 ID 和标题，页面上显示成
 * 会话「<标题>」并链到会话页。依据是控制面收到的请求带着哪个会话的令牌，不是模型在对话里怎么说，也不是可以伪造的
 * `x-sfly-client` 标注。不是会话做的，响应里没有这个字段。
 */
export const SessionRef = z.object({ id: z.string(), title: z.string() });
export type SessionRef = z.infer<typeof SessionRef>;

/**
 * 会话列表里的一项。`created_by` 是发起人的昵称；`queue_position` 只在排队中（`status` 为 `queued`）时有值，
 * 从 1 起；`last_turn_outcome` 是上一轮的结局，还没有结束过的一轮时为 null。
 */
export const SessionListItem = z.object({
	id: SessionId,
	title: z.string(),
	status: SessionStatus,
	created_by: z.string(),
	created_at: Timestamp,
	/** 最近一次活动（新建、发话、事件落库）的时间。 */
	last_activity_at: Timestamp,
	queue_position: z.int().min(1).nullable(),
	last_turn_outcome: TurnOutcome.nullable(),
});
export type SessionListItem = z.infer<typeof SessionListItem>;

/**
 * 一个会话：列表项的字段，加它所在的项目（标识）、此刻的就绪状态，和排队中在等谁（`waiting_for`，不在排队时为 null；
 * `turn_queued` 不持久，刷新页面后靠它拿回在等谁，#544）。
 */
export const SessionView = SessionListItem.extend({
	project: z.string(),
	readiness: Readiness,
	waiting_for: WaitingFor.nullable(),
});
export type SessionView = z.infer<typeof SessionView>;

/**
 * `GET /projects/:project/sessions`：助手此刻能不能用，和项目里的会话：在做和排队中的在前，其余按最近活动倒序
 * （#551 的写法；#544 之前没有排队，在做的至多一个），最多 {@link SESSION_LIST_LIMIT} 个。
 */
export const SessionListResponse = z.object({
	readiness: Readiness,
	sessions: z.array(SessionListItem).max(SESSION_LIST_LIMIT),
	/** 会话超过 {@link SESSION_LIST_LIMIT} 个，更早的没有列出来（页面据此提示）。 */
	truncated: z.boolean(),
});
export type SessionListResponse = z.infer<typeof SessionListResponse>;

/** 查询参数：空字符串等于没给（和 http/actions.ts、http/run-list.ts 里的同名函数一样）。 */
const blankAsMissing = <S extends z.ZodType>(schema: S) =>
	z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

/** `GET /sessions/:id` 的 query：`before` 是序号，取比它小的事件（往前翻页）。 */
export const SessionDetailQuery = z.object({
	before: blankAsMissing(z.coerce.number().int().min(1).max(SESSION_SEQ_MAX)),
});
export type SessionDetailQuery = z.infer<typeof SessionDetailQuery>;

/**
 * `GET /sessions/:id`：会话，和最多 {@link SESSION_HISTORY_PAGE} 条持久事件（序号升序，没有 `before` 时是最新的
 * 一页）；`has_more` 为 true 表示更早的还有。
 */
export const SessionDetailResponse = SessionView.extend({
	events: z.array(PersistedSessionEvent).max(SESSION_HISTORY_PAGE),
	has_more: z.boolean(),
});
export type SessionDetailResponse = z.infer<typeof SessionDetailResponse>;

/**
 * `GET /sessions/:id/events` 的 query：`after` 是序号，从它之后的持久事件开始推（浏览器重连也可以带 `Last-Event-ID`，
 * 它不是整数或超过 {@link SESSION_SEQ_MAX} 的当作没带）。
 */
export const SessionEventsQuery = z.object({
	after: blankAsMissing(z.coerce.number().int().min(0).max(SESSION_SEQ_MAX)),
});
export type SessionEventsQuery = z.infer<typeof SessionEventsQuery>;
