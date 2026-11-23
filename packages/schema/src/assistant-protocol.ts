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
 * | `POST /sessions/:id/prompt` | {@link PromptCommandBody} | 202（旧的一轮还在退出时也是 202，见「一轮的状态」）；这个会话有一轮在正常地做 409 `turn_running`；起不了 503 | #540、#544 |
 * | `POST /sessions/:id/steer` | {@link SteerCommandBody} | 202；没有可以送到的一轮 409 `no_turn_running` | #544 |
 * | `POST /sessions/:id/abort` | {@link AbortCommandBody} | 202（重复调用无害，四种情况见 {@link AbortCommandBody}；一轮怎么停见「停止一轮」） | #540、#544 |
 * | `POST /sessions/:id/end` | — | 202（重复调用无害，见「结束会话」） | #544 |
 * | `GET /events?after=<纪元>:<序号>` | {@link AssistantEventsQuery} | 200，NDJSON 长连接（{@link AssistantStreamLine}），**每 {@link ASSISTANT_STREAM_HEARTBEAT_MS} 写一行心跳** | #540；续传 #545 |
 * | `GET /health` | — | 200 {@link AssistantHealth} | #540；模型 #548；进程数 #545 |
 *
 * 失败的回应体是 {@link AssistantErrorBody}。
 *
 * ## 一轮的状态（#544 起）
 *
 * 助手服务对一个会话只记一件事：这个会话的这一轮此刻处在哪个状态（不记项目，不排队：同一个项目同一时刻只把一轮交给助手服务
 * 是控制面的事）。
 *
 * - **没有一轮**：没有登记过，或者上一轮已经发出了 `turn_end`。
 * - **在做**：`prompt` 登记了这一轮，还没有开始停止。包括 pi 还没有拿到 `prompt` 的时候（在等旧的进程退出、起进程、准备 skill、
 *   连模型）。`prompt` 回 409 `turn_running`、`steer` 回 202，都只看这个状态。
 * - **在停止**：这一轮已经决定结束（收到 `abort`、到了上限、收到 `end`），还没有发出 `turn_end`。分两段：先等 pi 报告
 *   `agent_settled`，最多 {@link ASSISTANT_ABORT_SETTLE_MS}；没等到就结束 pi 进程（先 SIGTERM，{@link ASSISTANT_PROCESS_KILL_GRACE_MS}
 *   之后 SIGKILL），进程退出之后才发 `turn_end`。从决定结束到发出 `turn_end`，最晚 {@link ASSISTANT_STOP_WAIT_MS}。
 *
 * 命令在各状态下的回应：
 *
 * | 状态 | `prompt` | `steer` | `abort` |
 * |---|---|---|---|
 * | 没有一轮 | 登记这一轮、202、再去起 | 409 `no_turn_running` | 记下记号（{@link AbortCommandBody}）、202 |
 * | 在做 | 409 `turn_running` | 202 | 进入「在停止」、202 |
 * | 在停止 | 登记新的一轮、202、**等这一轮结束再起**（下面第 1 条） | 409 `no_turn_running` | 202，什么也不加 |
 *
 * 1. **旧的一轮还在停止、或者它的 pi 进程还在退出时来了新的一轮（`prompt`）**：不回 409。助手服务登记新的一轮、回 202，
 *    等旧的一轮发出 `turn_end`（需要结束进程的，等进程退出）之后再起新的一轮：旧的进程还活着就用它（会话文件在，不重起），
 *    已经退出了就按启动命令起一个。**等的时间从旧的一轮决定结束那一刻算，最多 {@link ASSISTANT_STOP_WAIT_MS}**；旧的进程
 *    在这么久之内还没有退出（SIGKILL 之后也没有），新的一轮不开始，以 `failed` 结束，`turn_end.reason` 写明原因
 *    （上一轮的进程没有退出，所以这一轮没有开始），`error_class` 不写。旧的一轮发出的事件带旧的轮次，控制面按轮次核对，
 *    不属于此刻这一轮的丢掉，所以两轮的事件不会混。等着的这段时间新的一轮已经是「在做」：再来 `prompt` 回 409，`steer` 回 202
 *    （见 {@link SteerCommandBody}），`abort` 带它的轮次时按「在做」处理（还没有开始的话，等于它从没开始就结束，不起 pi）。
 *    控制面不用为这件事多等，也不会因此看到 409。
 * 2. **`prompt` 撞上中止的记号**（{@link AbortCommandBody}）：回 202、再发这一轮 `stopped` 的 `turn_end`，不起 pi。
 *    更早的一轮还在停止、或者进程还在退出时也是这样：**不回 409**（记号比「旧的一轮还没完」优先）。
 * 3. **只有同一个会话真的有一轮在正常地做（「在做」）时，`prompt` 才回 409 `turn_running`。**
 *
 * ## 停止一轮（#544 起）
 *
 * 用户停止、一轮到了上限（40 次模型调用或 20 分钟，结局是 `limit`）、结束会话，三件事走同一条路，模型够不着：
 *
 * 1. 决定结束：进入「在停止」；
 * 2. 取回还没送到模型的插话：先发 pi 的 `clear_queue`，加上助手服务自己还留着、没有交给 pi 的插话（{@link SteerCommandBody}），
 *    **各发一条 `notice`（`kind` 是 `steer_dropped`，`message_id` 是这句话的 ID，`message` 写明是哪句：引用原文，太长的截断）**，
 *    这些话不送到模型。必须先于 `abort`：`abort` 之后 pi 可能已经把它们送出去了；
 * 3. 发 pi 的 `abort`，等 `agent_settled`，最多 {@link ASSISTANT_ABORT_SETTLE_MS}；pi 中止正在跑的命令，工作台上命令的进程树随
 *    连接断开结束（#539 第 6 题：实测 0.08 秒）；
 * 4. 等到了就发这一轮的 `turn_end`（`stopped` 或 `limit`），**pi 进程留着**，下一轮接着用（#539：`abort` 之后同一个进程再发一轮照常做）；
 *    没等到就结束 pi 进程：先关 stdin、SIGTERM，{@link ASSISTANT_PROCESS_KILL_GRACE_MS} 之后 SIGKILL，进程退出之后再发 `turn_end`
 *    （这一轮的结局不变，还是 `stopped` 或 `limit`）。
 *
 * 决定结束之后 pi 还在吐的事件不外传。**`steer_dropped` 的 `notice` 都排在这一轮的 `turn_end` 前面**。控制面收到 `abort` 之后
 * 等这一轮的结局最多 {@link ASSISTANT_STOP_WAIT_MS}（它引用同一个常量）。助手服务不知道项目，也不管这一轮停下之后哪个会话接着做。
 *
 * ## 结束会话（#544 起）
 *
 * `POST /sessions/:id/end`：这个会话不会再有新的一轮。如果有一轮在做，先照「停止一轮」处理（控制面通常已经先停止了，所以这里多半
 * 只是一个空闲的会话）；等这一轮的 `turn_end` 发出之后，**关闭这个会话的 pi 进程**（关 stdin，宽限 {@link ASSISTANT_PROCESS_KILL_GRACE_MS}），
 * 忘掉它在内存里记着的东西（中止的记号、没送到的插话）、释放进程槽位。回应是 202，不等进程退出；重复调用无害；助手服务不认识的会话也是 202。
 * **不删任何东西**：会话目录（pi 的会话文件、`events.jsonl`）和工作台上的工作区都留着。助手服务不记得会话已经结束（重启之后更不会知道）：
 * 控制面保证结束之后不再发这个会话的命令。
 * 失败的回应体是 {@link AssistantErrorBody}。
 */

/**
 * 助手服务结束 pi 进程时的宽限（毫秒）：先关 pi 的输入、发 SIGTERM，等进程自己退出，**宽限到了还没退出才 SIGKILL**；
 * 这一轮的 `turn_end` 在进程退出**之后**才发。#544 之前停止一轮就是直接走这一步，收到 `abort` 之后结局最晚在这么久
 * （外加命令往返）之后带回；#544 起停止先用 pi 的 `abort`，等 {@link ASSISTANT_ABORT_SETTLE_MS} 没有结果才走这一步
 * （最晚的时间见 {@link ASSISTANT_STOP_WAIT_MS}）。**助手服务和控制面引用同一个数**。
 */
export const ASSISTANT_PROCESS_KILL_GRACE_MS = 10_000;

/**
 * #544 起：停止一轮时发了 pi 的 `abort` 之后，等 `agent_settled` 的最长时间（毫秒）；没等到就结束 pi 进程
 * （{@link ASSISTANT_PROCESS_KILL_GRACE_MS}）。实测 `abort` 0.08 秒就回（#539 第 6 题），这个数是兜底：pi 不理 `abort` 时
 * 用户最多多等这么久。一轮到了上限走同一条路，用同一个数。
 */
export const ASSISTANT_ABORT_SETTLE_MS = 10_000;

/**
 * 停止一轮时，在 {@link ASSISTANT_ABORT_SETTLE_MS} 和 {@link ASSISTANT_PROCESS_KILL_GRACE_MS} 之外多留的余量（毫秒）：
 * 盖过助手服务内部的命令往返（经能力端口结束工作台上的命令、取回插话、写结局）。
 */
export const ASSISTANT_STOP_MARGIN_MS = 3_000;

/**
 * 助手服务从决定结束一轮（收到 `abort`、到了上限、收到 `end`）到发出这一轮的 `turn_end`，最晚的时间（毫秒）：
 * 等 `agent_settled` 的 {@link ASSISTANT_ABORT_SETTLE_MS}，加结束进程的宽限 {@link ASSISTANT_PROCESS_KILL_GRACE_MS}，
 * 加余量 {@link ASSISTANT_STOP_MARGIN_MS}。**两处引用它，必须是同一个数**：
 * - 控制面停止一轮时等这一轮的结局（控制面的 `STOP_GRACE_MS`，#544 起换成它）：短了的话控制面先补一条 `stopped`、会话回到空闲，
 *   用户马上再说一句，助手服务那边上一轮还挂着；
 * - 助手服务里，旧的一轮还在停止时来了新的一轮，新的一轮最多等旧的一轮结束这么久，等不到就以 `failed` 结束
 *   （见「一轮的状态」第 1 条）。
 */
export const ASSISTANT_STOP_WAIT_MS =
	ASSISTANT_ABORT_SETTLE_MS + ASSISTANT_PROCESS_KILL_GRACE_MS + ASSISTANT_STOP_MARGIN_MS;

/** 共享密钥放在助手服务和控制面各自的这个环境变量里。 */
export const ASSISTANT_SECRET_ENV = "SFLY_ASSISTANT_SECRET";

/** 共享密钥的最短长度（字符数）：短于它助手服务拒绝启动。 */
export const ASSISTANT_SECRET_MIN_LENGTH = 32;

/**
 * 助手服务命令的错误码（{@link AssistantErrorBody}）：
 * - 401 `unauthorized`：缺了密钥或不对；
 * - 400 `invalid_request`：请求体或路径不合 schema；
 * - 409 `turn_running`：开始一轮时这个会话有一轮在正常地做（「一轮的状态」里的「在做」；旧的一轮还在停止或进程还在退出时不是，
 *   那种情况回 202）；409 `no_turn_running`：插话时没有可以送到的一轮（没有一轮、在停止、已经结束）；
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
 * 这一轮在哪个工作台上做：`name` 是工作台的 Agent 名，`address` 是它的能力端口的地址，写成 `主机:端口`（IPv6 地址写成
 * `[地址]:端口`；主机和端口取 Agent 上报的，ADR 0019），`workdir` 是工作区在工作台上的路径。pi 的读、写、编辑、命令四个工具经远程工具扩展落到这个地址。
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
 * - `message_id`：这句话的 ID（`user_message.message_id`，控制面收到时分配）；
 * - `session`：会话的标题和发起人（昵称）：助手服务不存业务状态，每一轮的提交说明（会话标题、会话 ID、第几轮）和提交的
 *   作者（发起人）要用，#546；
 * - `env`：这一轮在工作台上执行命令时要加的**普通**环境变量，由控制面的一个函数生成，每一轮可以不同：竖切里是
 *   `SFLY_NICKNAME`（发起这句话的人的昵称）和 `AI_AGENT=pi`；
 * - **收到 `prompt` 先登记这一轮（`turn`、有一轮在做），再做慢的事**（起 pi 进程、准备 skill、连模型）：控制面等回应最多
 *   10 秒，超时的结果是未知的，控制面会补发一次带这一轮轮次的 `abort`（{@link AbortCommandBody}）；登记得早，`abort`
 *   到达时就能直接结束它。`abort` 先于这一轮的 `prompt` 到达也不要紧：助手服务记下「这一轮已被中止」，这一轮的 `prompt`
 *   到了就直接以 `stopped` 结束。
 * - `secret_env`：要加的**保密**环境变量，#547 起里面有 `SFLY_API_TOKEN`（会话令牌）。工作台上的命令读得到它，模型一执行
 *   列环境变量的命令，它就会进工具的输出和持久的 `tool_result`，所以单独成一份：**它不进任何事件、不进助手服务的日志；
 *   助手服务在发出事件之前，要把事件里出现的这些值按值打码**（#540 的要求）。
 */
export const PromptCommandBody = z.object({
	turn: z.int().min(1),
	message_id: z.uuid(),
	text: SessionMessageText,
	session: z.object({ title: z.string(), created_by: z.string() }),
	workbench: WorkbenchTarget,
	env: z.record(EnvName, z.string()),
	secret_env: z.record(EnvName, z.string()),
});
export type PromptCommandBody = z.infer<typeof PromptCommandBody>;

/**
 * `POST /sessions/:id/steer`：插话，助手服务发 pi 的 `steer`。`message_id` 是这句话的 ID（`user_message.message_id`）：
 * 助手服务在 `steer_queue` 里原样带回它，页面不靠文字对应。
 *
 * **什么时候接受**：会话处在「在做」（见「一轮的状态」）就回 202，包括 pi 还没有拿到 `prompt` 的时候（在等旧的进程退出、
 * 起进程、准备 skill）：助手服务先自己留着，`prompt` 交给 pi 之后按收到的顺序依次发 `steer`；这几句话在 `steer_queue` 里照常
 * 显示。没有一轮、在停止、已经结束时回 409 `no_turn_running`：控制面（它在这句话到之前写过 `user_message`，`steer: true`）
 * **为这句话写一条 `notice`（`steer_dropped`，`message_id` 是这句话的 ID），不重试，也不当作新的一轮**：用户在时间线上看到
 * 这句话没有送到，可以再说一次。
 *
 * **什么时候送到**（#539 第 7 题的实测，和 pi 的文档一致）：在当前这一步的工具调用做完之后、下一次调用模型之前。当前这一步是
 * `sfly run wait` 这类长命令时，要等它做完，所以页面写明「要马上停下用停止」。不做 pi 的 `follow_up`：进行中只有插话一种。
 * 助手服务不改 pi 的设置，**不依赖 pi 一次送一句还是几句一起送**：每一句各自以「出现了这句话的用户消息」（pi 的 `message_end`，
 * `role` 是 `user`）为准算送到，不看 `queue_update` 的 `steering` 变空（`clear_queue` 之后它也会变空，两件事分不清）。
 *
 * **三种边界**：
 * - **最后一次模型回复不带工具调用时发的插话**：这次回复照常结束，pi 带着插话再请求一次模型，这一轮接着做，插话不丢，也不等到下一次
 *   `prompt`（实测假模型先等 4 秒才开始输出，所以测的是「模型还没开始输出」，不是「输出到一半」）。助手服务看到 pi 报告 `agent_settled`
 *   而插话还没有送到时（不该发生），在发 `turn_end` 之前为每一句各发一条 `steer_dropped` 的 `notice`；
 * - **停止时还没送到的插话**：不送到模型，各发一条 `steer_dropped` 的 `notice`（「停止一轮」第 2 步），排在 `turn_end` 前面；
 * - **连着发两句**：都留着，按收到的顺序送，每一句各有自己的 `message_id`，各是一条用户消息；相同的两句话靠顺序区分。
 *
 * **送到时助手服务不发 `user_message`**（控制面收到这句话时已经写了）：它只发 `steer_queue`，这句话从列表里去掉。`steer_queue` 是
 * 还没送到的完整列表，每次变化发一条取代上一条（空列表也发，表示都送到或都丢了），不持久。pi 的队列里没有 `message_id`：助手服务
 * 自己按收到的顺序记着每句话的 ID，用 pi 的 `queue_update` 和用户消息的出现按顺序对上。
 */
export const SteerCommandBody = z.object({ message_id: z.uuid(), text: SessionMessageText });
export type SteerCommandBody = z.infer<typeof SteerCommandBody>;

/**
 * `POST /sessions/:id/abort`：结束会话里的**某一轮**（`turn`，控制面给的轮次，和 `prompt` 里的 `turn` 是同一个）。
 * 不按「会话里有没有在做」、更不按时间去猜（不按时间判断「是哪一轮」），按轮次，四种情况：
 *
 * - **这一轮在做**：中止它，带回它的 `turn_end`（`stopped`）；
 * - **还在做的那一轮，轮次比 N 小**：也结束它。控制面看来比 N 早的轮次都已经结束了（它们的结局是控制面补的，或者助手服务回过一次
 *   409 `turn_running` 之后控制面已经把那次发话的轮次记成失败、轮次加了一）：助手服务那边还在跑的更早的轮次是没人管的，最多
 *   跑到上限（二十分钟）。这样定是安全的：不会碰到比 N 更新的轮次；
 * - **这一轮还没登记**（它的 `prompt` 还没处理完、或者还没到）：记下「这一轮已被中止」，这一轮的 `prompt` 到了就直接以 `stopped`
 *   结束，不去做；
 * - **这一轮已经结束**，也没有更早的还在做：什么也不做，202。
 *
 * 助手服务重启之后不知道最近一轮是哪一轮，分不清「已经结束」和「还没登记」时，**当作还没登记记下**：记号只和同一轮的 `prompt`
 * 对得上（只认轮次，不看时间），轮次只增，记错了也不会误伤别的轮次。这一轮的 `prompt` 撞上记号时，**先回 202、再发这一轮
 * `stopped` 的 `turn_end`**（回 409 或 503，控制面会把这一轮记成失败）。每个会话只留轮次最大的那个记号就够：收到轮次不小于它的
 * `prompt` 时清掉。记号可以过期、可以设个上限（这和「不按时间判断」不矛盾：说的是不能靠「刚刚才结束」这类时间关系去猜一个
 * 中止是给哪一轮的，不是说记号不能清理）。收到中止之后怎么停、最晚多久带回结局，见「停止一轮」
 * （{@link ASSISTANT_ABORT_SETTLE_MS}、{@link ASSISTANT_PROCESS_KILL_GRACE_MS}、{@link ASSISTANT_STOP_WAIT_MS}）。
 *
 * 别的轮次不受影响：用户在空闲的会话上点了停止、紧接着说一句话，新的一轮（轮次更大）照常做。控制面带的轮次：用户点停止时
 * 是此刻在做的那一轮；`prompt` 超时之后补发的是那一轮；会话空闲时点停止是最近的那一轮（它已经结束的话什么也不会发生）。
 * 重复调用无害。
 */
export const AbortCommandBody = z.object({ turn: z.int().min(1) });
export type AbortCommandBody = z.infer<typeof AbortCommandBody>;

/**
 * 助手服务产生的会话事件：{@link SessionEventBody} 里由它产生的几种（`notice` 只有它产生的几种，`platform` 只有
 * `commit`），事件流里的 `event` 就是它。用户的话、一轮开始、排队、会话结束、`snapshot` 由控制面产生，不在其中；
 * 控制面补的 `interrupted` 的 `turn_end`、`events_lost`、`queue_cancelled`，以及插话被助手服务回 409 `no_turn_running` 时那句话的
 * `steer_dropped`，也由控制面直接写，不经助手服务。
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
 * 事件流的心跳：助手服务每隔 {@link ASSISTANT_STREAM_HEARTBEAT_MS} 在事件流里写一行 `{"type":"heartbeat"}`，不论有没有事件。
 * 没有会话在做时事件流可以几个小时没有任何内容；HTTP 客户端的响应体超时（Node 的 `fetch` 默认 300 秒）会把这样的连接
 * 掐断，而协议现在没有续传（#545），断开期间的事件就丢了。心跳让连接不空闲，也让控制面能分清「静默」和「死了」：
 * 超过 {@link ASSISTANT_STREAM_IDLE_INTERVALS} 个间隔没有收到任何字节（心跳、事件都算），控制面就认为连接已经死了
 * （半开的连接、对端挂住），主动断开重连，不等响应体超时。**只增，不影响已有的行**：不认识心跳的控制面按「不是约定的形状」
 * 跳过它（但会因此没有死连接检测）。
 */
export const AssistantStreamHeartbeat = z.object({ type: z.literal("heartbeat") });
export type AssistantStreamHeartbeat = z.infer<typeof AssistantStreamHeartbeat>;

/** 助手服务写心跳的间隔（毫秒）。 */
export const ASSISTANT_STREAM_HEARTBEAT_MS = 15_000;

/** 控制面超过几个心跳间隔没有收到事件流里的任何字节，就认为连接死了。 */
export const ASSISTANT_STREAM_IDLE_INTERVALS = 3;

/**
 * 事件流里的一条事件记录（NDJSON 的一行）：`seq` 是助手服务内递增的序号，**只有持久的事件有**
 * （{@link PERSISTED_SESSION_EVENT_TYPES}：持久的必须有，不持久的不能有；它不是会话内序号，会话内序号由控制面
 * 落库时给）；`turn` 是这个事件属于哪一轮；`at` 是助手服务产生这个事件的时间：控制面原样存成持久事件的 `at`
 * （不是落库的时间，所以控制面重启后补收的事件时间也对）。两个容器通常在同一台主机上，时钟的偏差接受。
 */
export const AssistantStreamRecord = z
	.object({
		epoch: AssistantEpoch,
		seq: z.int().min(1).optional(),
		session_id: SessionId,
		turn: z.int().min(1),
		at: Timestamp,
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

/**
 * 事件流的一行：第一行是 {@link AssistantStreamHello}，之后是 {@link AssistantStreamRecord}，夹着
 * {@link AssistantStreamHeartbeat}（每 {@link ASSISTANT_STREAM_HEARTBEAT_MS} 一行）。
 */
export const AssistantStreamLine = z.union([
	AssistantStreamHello,
	AssistantStreamHeartbeat,
	AssistantStreamRecord,
]);
export type AssistantStreamLine = z.infer<typeof AssistantStreamLine>;

/** 助手服务和它带的 pi 的版本。 */
export const AssistantVersions = z.object({
	assistant: z.string(),
	pi: z.string(),
});
export type AssistantVersions = z.infer<typeof AssistantVersions>;

/**
 * 助手服务看到的模型：配没配（`configured`）、连不连得上（`reachable`，没有配或还没检查过时为 null）、
 * 上次检查的时间和原因（`reason` 是一句话，`error_class` 是它按什么分；没有检查过或没有问题时都为 null），
 * 连的是哪个端点（`endpoint`：主机和端口，没有配时为 null；**只给主机和端口，不给路径和密钥**，就绪状态里
 * 显示连的是哪）。模型的检查和这些字段的取值由 #548 做。
 */
export const AssistantModelHealth = z.object({
	configured: z.boolean(),
	endpoint: z.object({ host: z.string().min(1), port: z.int().min(1).max(65535) }).nullable(),
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
