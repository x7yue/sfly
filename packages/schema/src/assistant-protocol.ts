import { z } from "zod";
import { Timestamp } from "./http/contract.js";
import {
	AssistantDeltaEvent,
	AssistantMessageEvent,
	AssistantNoticeEvent,
	ErrorClass,
	PERSISTED_SESSION_EVENT_TYPES,
	PlatformCommitEvent,
	SessionId,
	SessionMessageText,
	SteerQueueEvent,
	ThinkingEvent,
	ToolCallEvent,
	ToolOutputEvent,
	ToolResultEvent,
	TurnEndEvent,
} from "./sessions.js";

/**
 * 控制面和助手服务（GLOSSARY「助手服务」，`apps/assistant`）之间的协议（ADR 0027）。**不进控制面的 HTTP 契约**
 * （契约守卫只管控制面注册的路由），类型放在这里，两边都只用这些类型，也都不引用 pi 的类型（lint 规则
 * `pi-only-in-assistant` 守着）。
 *
 * - 传输：HTTP/1.1，JSON。连接总是由控制面发起：命令是控制面发的请求，事件是控制面打开的一条长连接。
 * - 鉴权：控制面的每个请求带 `Authorization: Bearer <SFLY_ASSISTANT_SECRET>`；助手服务按常量时间比较，
 *   缺了或不对返回 401。共享密钥短于 {@link ASSISTANT_SECRET_MIN_LENGTH} 个字符时助手服务拒绝启动，控制面把助手
 *   当作「没有配置」并在日志和就绪状态里写明原因。密钥不交给 pi 进程，不出现在任何事件和日志里。
 *
 * 命令（路径里的 `:id` 是 {@link SessionId}）：
 *
 * | 命令 | 请求体 | 回应 | 由哪条任务做 |
 * |---|---|---|---|
 * | `POST /sessions/:id/prompt` | {@link PromptCommandBody} | 202；这个会话已有一轮在做 409 `turn_running`；起不了 503 | #540 |
 * | `POST /sessions/:id/steer` | {@link SteerCommandBody} | 202；没有在做的一轮 409 `no_turn_running` | #544 |
 * | `POST /sessions/:id/abort` | — | 202（重复调用无害） | #540、#544 |
 * | `POST /sessions/:id/end` | — | 202（重复调用无害） | #544 |
 * | `GET /events?after=<纪元>:<序号>` | {@link AssistantEventsQuery} | 200，NDJSON 长连接（{@link AssistantStreamLine}） | #540；续传 #545 |
 * | `GET /health` | — | 200 {@link AssistantHealth} | #540；模型 #548；进程数 #545 |
 *
 * 失败的回应体是 {@link AssistantErrorBody}。
 */

/** 共享密钥放在助手服务和控制面各自的这个环境变量里。 */
export const ASSISTANT_SECRET_ENV = "SFLY_ASSISTANT_SECRET";

/** 共享密钥的最短长度（字符数）：短于它助手服务拒绝启动。 */
export const ASSISTANT_SECRET_MIN_LENGTH = 32;

/**
 * 助手服务命令的错误码（{@link AssistantErrorBody}）：
 * - 401 `unauthorized`：缺了密钥或不对；
 * - 400 `invalid_request`：请求体或路径不合 schema；
 * - 409 `turn_running`：开始一轮时这个会话已有一轮在做；409 `no_turn_running`：插话时没有在做的一轮；
 * - 503 `model_not_configured`、`model_unreachable`：模型没有配置或连不上，起不了（#548）；
 * - 503 `process_limit`：活着的 pi 进程数到了上限（#545）；
 * - 503 `start_failed`：其他原因起不了 pi 进程，`message` 写原因。
 */
export const AssistantErrorCode = z.enum([
	"unauthorized",
	"invalid_request",
	"turn_running",
	"no_turn_running",
	"model_not_configured",
	"model_unreachable",
	"process_limit",
	"start_failed",
]);
export type AssistantErrorCode = z.infer<typeof AssistantErrorCode>;

/** 助手服务失败的回应体。`message` 是给日志和排查的一句话，不含密钥。 */
export const AssistantErrorBody = z.object({
	code: AssistantErrorCode,
	message: z.string(),
});
export type AssistantErrorBody = z.infer<typeof AssistantErrorBody>;

/** 环境变量的名字：字母、数字、下划线，不以数字开头。 */
const EnvName = z
	.string()
	.regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "环境变量名只能有字母、数字、下划线，且不以数字开头");

/**
 * 这一轮在哪个工作台上做：`name` 是工作台的 Agent 名，`address` 是它的能力端口的地址，`workdir` 是工作区在工作台
 * 上的路径。pi 的读、写、编辑、命令四个工具经远程工具扩展落到这个地址。
 */
export const WorkbenchTarget = z.object({
	name: z.string().min(1),
	address: z.string().min(1),
	workdir: z.string().min(1),
});
export type WorkbenchTarget = z.infer<typeof WorkbenchTarget>;

/**
 * `POST /sessions/:id/prompt`：开始一轮。这个会话没有活着的 pi 进程就按启动命令起一个（有会话文件就恢复），
 * 准备好工作台上的 skill，把 `text` 作为 pi 的 `prompt` 发出。
 *
 * - `turn`：会话里第几轮（从 1 起），由控制面给，事件流里这一轮的事件都带它；
 * - `env`：这一轮在工作台上执行命令时要加的环境变量，由控制面的一个函数生成，每一轮可以不同：竖切里是
 *   `SFLY_NICKNAME`（发起这句话的人的昵称）和 `AI_AGENT=pi`，#547 起加 `SFLY_API_TOKEN`（会话令牌）。
 *   它里面有令牌，不出现在任何事件和日志里。
 */
export const PromptCommandBody = z.object({
	turn: z.int().min(1),
	text: SessionMessageText,
	workbench: WorkbenchTarget,
	env: z.record(EnvName, z.string()),
});
export type PromptCommandBody = z.infer<typeof PromptCommandBody>;

/** `POST /sessions/:id/steer`：插话，助手服务发 pi 的 `steer`。 */
export const SteerCommandBody = z.object({ text: SessionMessageText });
export type SteerCommandBody = z.infer<typeof SteerCommandBody>;

/**
 * 助手服务产生的会话事件：{@link SessionEventBody} 里由它产生的几种（`notice` 只有它产生的几种，`platform` 只有
 * `commit`），事件流里的 `event` 就是它。用户的话、一轮开始、排队、会话结束、`snapshot` 由控制面产生，不在其中；
 * 控制面补的 `interrupted` 的 `turn_end`、`events_lost`、`queue_cancelled` 也由控制面直接写，不经助手服务。
 */
export const AssistantEvent = z.discriminatedUnion("type", [
	ThinkingEvent,
	AssistantDeltaEvent,
	AssistantMessageEvent,
	ToolCallEvent,
	ToolOutputEvent,
	ToolResultEvent,
	SteerQueueEvent,
	AssistantNoticeEvent,
	TurnEndEvent,
	PlatformCommitEvent,
]);
export type AssistantEvent = z.infer<typeof AssistantEvent>;

/** 助手服务每次启动生成的随机 ID：序号只在同一个纪元里连续。 */
export const AssistantEpoch = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export type AssistantEpoch = z.infer<typeof AssistantEpoch>;

/**
 * `GET /events` 的 query：`after` 写成 `<纪元>:<序号>`，从这条之后续传（#545 实现；在那之前 `after` 被忽略，
 * 只推实时的）。
 */
export const AssistantEventsQuery = z.object({
	after: z
		.string()
		.regex(/^[A-Za-z0-9_-]{1,64}:\d+$/, "after 要写成 <纪元>:<序号>")
		.optional(),
});
export type AssistantEventsQuery = z.infer<typeof AssistantEventsQuery>;

/**
 * 事件流的第一行：`epoch` 是助手服务当前的纪元；`gap` 为 true 表示 `after` 的纪元和当前的不同，或者 `after` 早于
 * 助手服务内存里保留的最早一条，中间有事件已经补不回来（控制面要写一条 `events_lost`，#545）。
 */
export const AssistantStreamHello = z.object({
	type: z.literal("hello"),
	epoch: AssistantEpoch,
	gap: z.boolean(),
});
export type AssistantStreamHello = z.infer<typeof AssistantStreamHello>;

/**
 * 事件流里的一条事件记录（NDJSON 的一行）：`seq` 是助手服务内递增的序号，**只有持久的事件有**
 * （{@link PERSISTED_SESSION_EVENT_TYPES}：持久的必须有，不持久的不能有；它不是会话内序号，会话内序号由控制面
 * 落库时给）；`turn` 是这个事件属于哪一轮。
 */
export const AssistantStreamRecord = z
	.object({
		epoch: AssistantEpoch,
		seq: z.int().min(1).optional(),
		session_id: SessionId,
		turn: z.int().min(1),
		event: AssistantEvent,
	})
	.superRefine((record, ctx) => {
		const persisted = (PERSISTED_SESSION_EVENT_TYPES as readonly string[]).includes(
			record.event.type,
		);
		if (persisted && record.seq === undefined) {
			ctx.addIssue({ code: "custom", path: ["seq"], message: "持久的事件要带 seq" });
		}
		if (!persisted && record.seq !== undefined) {
			ctx.addIssue({ code: "custom", path: ["seq"], message: "不持久的事件不带 seq" });
		}
	});
export type AssistantStreamRecord = z.infer<typeof AssistantStreamRecord>;

/** 事件流的一行：第一行是 {@link AssistantStreamHello}，之后是 {@link AssistantStreamRecord}。 */
export const AssistantStreamLine = z.union([AssistantStreamHello, AssistantStreamRecord]);
export type AssistantStreamLine = z.infer<typeof AssistantStreamLine>;

/** 助手服务和它带的 pi 的版本。 */
export const AssistantVersions = z.object({
	assistant: z.string(),
	pi: z.string(),
});
export type AssistantVersions = z.infer<typeof AssistantVersions>;

/**
 * 助手服务看到的模型：配没配（`configured`）、连不连得上（`reachable`，没有配或还没检查过时为 null）、
 * 上次检查的时间和原因（`reason` 是一句话，`error_class` 是它按什么分；没有检查过或没有问题时都为 null）。
 * 模型的检查和这些字段的取值由 #548 做。
 */
export const AssistantModelHealth = z.object({
	configured: z.boolean(),
	reachable: z.boolean().nullable(),
	checked_at: Timestamp.nullable(),
	reason: z.string().nullable(),
	error_class: ErrorClass.nullable(),
});
export type AssistantModelHealth = z.infer<typeof AssistantModelHealth>;

/** `GET /health`：纪元、版本、模型、活着的 pi 进程数和上限（`processes.limit` 没有设上限时为 null）。 */
export const AssistantHealth = z.object({
	epoch: AssistantEpoch,
	versions: AssistantVersions,
	model: AssistantModelHealth,
	processes: z.object({
		active: z.int().min(0),
		limit: z.int().min(1).nullable(),
	}),
});
export type AssistantHealth = z.infer<typeof AssistantHealth>;
