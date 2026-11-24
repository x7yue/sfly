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
 * 命令（路径里的 `:id` 是 {@link SessionId}）。**每条命令都是收到并决定了怎么办就回应**，不等命令引起的事做完：
 *
 * | 命令 | 请求体 | 回应 | 由哪条任务做 |
 * |---|---|---|---|
 * | `POST /sessions/:id/prompt` | {@link PromptCommandBody} | 202；这个会话有一轮在做、而且 `prompt` 带的轮次比中止记号大：409 `turn_running`；**登记之前**就知道起不了（容量满、助手服务正在关闭等）：503，这样的 `prompt` 没有登记、不会有任何事件（旧的一轮还在停止时是 202） | #540、#544 |
 * | `POST /sessions/:id/steer` | {@link SteerCommandBody} | 202；`turn` 那一轮没有在做：409 `no_turn_running` | #544 |
 * | `POST /sessions/:id/abort` | {@link AbortCommandBody} | 202，总是；重复调用无害 | #540、#544 |
 * | `POST /sessions/:id/end` | — | 202，总是；重复调用无害，不认识的会话也是 202 | #544 |
 * | `GET /events?after=<纪元>:<序号>` | {@link AssistantEventsQuery} | 200，NDJSON 长连接（{@link AssistantStreamLine}），**每 {@link ASSISTANT_STREAM_HEARTBEAT_MS} 写一行心跳** | #540；续传 #545 |
 * | `GET /health` | — | 200 {@link AssistantHealth} | #540；模型 #548；进程数 #545 |
 *
 * 失败的回应体是 {@link AssistantErrorBody}。
 *
 * **怎么读下面几节**：从「一轮的状态」到「结束会话」写的是 #544 做成之后的行为，**里面不写 dev 上现在怎么样**；dev 上现在的实现、
 * 和 #544 要做成的差别、各部分由控制面还是助手服务来做，只写在最后一节「各部分的进度」里。需要实测才能定的几处，写成
 * 「544-B 先测」：测到的结果和这里写的不一样时，先改这份协议，再改实现。
 *
 * ## 一轮的状态（#544 起）
 *
 * 助手服务对一个会话记两样东西：这个会话的轮次此刻处在哪个状态，和**中止记号**。不记项目，不排队：同一个项目同一时刻只把一轮交给
 * 助手服务是控制面的事。「第 n 轮」的 n 是控制面给的轮次：`prompt`、`steer`、`abort` 和事件都带它，同一个会话里只增。
 *
 * **四个状态**：
 * - **没有一轮**：没有登记过，或者上一轮已经发出了 `turn_end`。
 * - **在做（第 n 轮）**：`prompt` 登记了第 n 轮，还没有决定结束它。**包括 pi 还没有拿到 `prompt` 的时候**（在等旧的进程退出、
 *   起进程、准备 skill、连模型）。
 * - **在停止（第 m 轮）**：已经决定结束第 m 轮（收到 `abort`、到了上限、收到 `end`），还没有发出它的 `turn_end`。怎么停、
 *   最晚多久，见「停止一轮」。
 * - **在停止（第 m 轮）、第 k 轮在等**：第 m 轮在停止时，第 k 轮（k 大于 m）的 `prompt` 到了。第 k 轮已经登记，是「在做」，
 *   只是还没有开始，要等第 m 轮的 `turn_end`（下面「`prompt` 的判断」第 3 条）。同一个会话最多就这两轮。**第 k 轮被中止之后不再算在做**：
 *   它立即结束（下表「`abort`」一列），状态回到「在停止（第 m 轮）」。
 *
 * **中止记号**：每个会话一个整数，叫「中止到第几轮」：第 1 轮到这个数的轮次都不该再做了。没有记号时当作 0。
 * - `abort` 带的轮次是 N：记号提到 N；记号已经不小于 N 时不变。**记号只增不减。**
 * - **轮次不大于记号的 `prompt` 一律回 202、以 `stopped` 结束、不起 pi**（`turn_end.reason` 写这一轮到之前已经要求停止了）。
 *   **收到 `prompt` 不会清掉记号**，也不改任何别的状态：控制面已经放弃的轮次（轮次不大于某次 `abort` 带的 N 的，轮次只增），
 *   它们的 `prompt` 在任何先后下都不会再跑，晚到多久、记号被用过几次都一样。轮次比记号大的 `prompt` 不受记号影响。
 *   **控制面保证两件事，记号才起作用**：`prompt` 的轮次总比它之前发过的 `prompt` 都大；放弃一轮（`prompt` 超时、用户停止）时，带着这一轮的
 *   轮次发过 `abort`（这次 `abort` 是尽力而为的：没送到时记号不在，晚到的 `prompt` 会照常做，控制面靠之后点停止时再补发一次兜底）。
 *   控制面还有两处结束一轮时不发 `abort`：30 分钟没有动静的兜底（`expireStale`）、启动时收拾重启前在做的会话（#545）；一轮最长 20 分钟，
 *   这两种靠用户之后点停止兜底（空闲的会话点停止，带最近那一轮的 `abort`）。
 * - 十分钟没有被提高就过期，过期的记号当作没有；助手服务重启之后不记得，当作没有；`end` 不动它。助手服务可以限制同时记着记号的
 *   会话数，满了丢最早的：对控制面没有区别。
 *
 * **命令在各状态下的回应**。每一格写「回应是什么、之后发生什么」。三条通用的规则：
 * - **`prompt` 先看记号**：轮次 t 不大于记号时，在任何状态下都是 202、发 t 的 `turn_end`（`stopped`）、不起 pi，其余的格子都不适用，
 *   这个会话里别的轮次（在做的、在停止的、在等的）都不受影响。下表的 `prompt` 一列只写 t 大于记号的情况。
 * - **`abort` 先把记号提到 N**，再按下表处理；下表的 `abort` 一列只写记号之外发生的事。
 * - `abort`、`end` 的 202 都是收到并决定了怎么办就回，**不等这一轮的 `turn_end`**，也不等进程退出。
 *
 * | 状态 | `prompt`（轮次 t） | `steer`（轮次 t） | `abort`（轮次 N） | `end` |
 * |---|---|---|---|---|
 * | 没有一轮 | 登记第 t 轮为「在做」、202（登记之前判断容量等：满了回 503，没有登记）；然后在后台起 pi（没有活着的进程就起，有就用；这时才发现起不了的，这一轮以 `failed` 结束，不是 503）、交 `prompt` | 409 `no_turn_running` | 202；除了记号什么也不发生：之后轮次不大于 N 的 `prompt` 都以 `stopped` 结束 | 202；关闭这个会话的 pi 进程（有的话）、释放进程槽位 |
 * | 在做（第 n 轮） | 409 `turn_running`，什么也不变 | t 等于 n：202，留着或交给 pi（见「插话」）；t 不等于 n：409 `no_turn_running` | n 不大于 N：202，第 n 轮进入「在停止」；n 大于 N：202，不动它（第 n 轮比 N 新） | 202；第 n 轮进入「在停止」（结局 `stopped`），它的 `turn_end` 照常发，**发出之后**关闭 pi 进程 |
 * | 在停止（第 m 轮） | 登记第 t 轮为「在做」、202，进入「在停止、第 t 轮在等」；等第 m 轮的 `turn_end` 之后再开始（第 3 条）。**这一格只在控制面等不到结局、自己补上之后才会走到**（见「停止一轮」的控制面一侧） | 409 `no_turn_running` | 202；第 m 轮照常停止，没有别的变化（N 和 m 谁大都一样） | 202；第 m 轮照常停止，它的 `turn_end` 发出之后关闭 pi 进程 |
 * | 在停止（第 m 轮）、第 k 轮在等 | 409 `turn_running`（第 k 轮是「在做」；第 k 轮被中止之后状态回到「在停止（第 m 轮）」，那时的 `prompt` 照上一行登记） | t 等于 k：202，留着，第 k 轮开始之后按收到的顺序交给 pi；t 不等于 k（包括等于 m）：409 `no_turn_running` | 202；第 m 轮照常停止；k 不大于 N：第 k 轮**立即**以 `stopped` 结束（发它的 `turn_end`，不起 pi，它的插话各发 `steer_dropped`、排在这条 `turn_end` 前面），状态回到「在停止（第 m 轮）」；k 大于 N：不动第 k 轮 | 202；第 m 轮照常停止，第 k 轮同 `abort` 的 k 不大于 N（立即 `stopped`），第 m 轮的 `turn_end` 发出之后关闭 pi 进程 |
 *
 * 「在做 × `end`」「在停止 × `end`」这几格**只有控制面等不到结局、自己补了结局之后才会走到**（助手服务那边那一轮其实还在做、或者还在停止）：
 * 控制面照「结束会话」的先后，先停止并等到结局、再写 `session_ended`、才发 `end`，所以正常的 `end` 到的时候，这个会话在助手服务这边是「没有一轮」。
 *
 * **`prompt` 的判断，先后是固定的**：
 * 1. 轮次不大于中止记号：202、`stopped`、不起 pi（上面的第一条通用规则）。
 * 2. 否则，这个会话有一轮「在做」（包括「在停止、第 k 轮在等」里的、没有被中止的第 k 轮）：409 `turn_running`。**只有这一种情况回 409。**
 *    第 k 轮被中止之后不再算在做，之后轮次比记号大的 `prompt` 照第 3 条登记。
 * 3. 否则（没有一轮，或者有一轮在停止）：登记这一轮，回 202。有一轮在停止的话，这一轮等它结束再开始：
 *    - 开始的条件是第 m 轮的 `turn_end` 发出（需要结束进程的，等进程退出之后）。旧的进程还活着（`abort` 之后留着的）就用它，
 *      已经退出了就按启动命令起一个（有会话文件就恢复，不重起会话）；
 *    - **最多等的时间从第 m 轮决定结束的那一刻（「停止一轮」里的 T0）起算，{@link ASSISTANT_STOP_WAIT_MS}**，不是从这一轮的
 *      `prompt` 到达算：旧的进程在这么久之内还没有退出（SIGKILL 之后也没有），这一轮不开始，以 `failed` 结束，`turn_end.reason`
 *      写明原因（上一轮的进程没有退出，所以这一轮没有开始），`error_class` 不写。进程在 SIGKILL 之后一般马上退出，所以这种
 *      `failed` 只在进程卡在不可中断的状态时才会出现；已经被中止的第 k 轮早就 `stopped` 了，这里说的是没有被中止、还在等的那一轮；
 *    - 旧的一轮发出的事件带旧的轮次，控制面按轮次核对，不属于此刻这一轮的丢掉，所以两轮的事件不会混；
 *    - 控制面不用为这件事多等，也不会因此看到 409。
 *
 * ## 停止一轮（#544 起）
 *
 * 用户停止（`abort`）、一轮到了上限（40 次模型调用或 20 分钟，结局是 `limit`）、结束会话时这一轮在做（`end`），三件事走同一条路，
 * 模型够不着。**决定结束这一轮的那一刻记作 T0**：助手服务收到 `abort`（或 `end`）并且这一轮要结束的那一刻，或者上限的计时到的那一刻，
 * 用助手服务自己的时钟。**助手服务这一侧所有的计时都从 T0 起算**，步骤是：
 *
 * 1. T0：这一轮进入「在停止」。**从这一刻起助手服务不再外传这一轮的 `steer_queue`**，pi 之后还在吐的事件（消息、工具调用等）
 *    也不外传；助手服务自己的记录（哪几句插话送到了）照常更新，下面第 4 步要用。
 * 2. T0：**接连**向 pi 写 `clear_queue` 和 `abort`，**不等前一条的回应**。顺序是先 `clear_queue`、后 `abort`：`abort` 之后
 *    留在 pi 队列里的插话还会被继续处理，所以队列要先清。**544-B 先测**：`abort` 紧跟在 `clear_queue` 后面写出时，没有插话漏出去
 *    （pi 的 RPC 里 `clear_queue` 是同步执行的，命令按收到的先后分派，`abort` 一定在它之后执行）。**退路**：有漏的话，改成先写
 *    `clear_queue`、等它的回应再写 `abort`，等的时间算在 T0 起算的 SETTLE 里，回应到不了就走结束进程那条路（队列随进程消失）；
 *    这对控制面没有区别，不用改协议。
 *    这一轮还没有把 `prompt` 交给 pi 的（在等旧的一轮、起进程、准备 skill），没有可清的、可中止的，也没有 `agent_settled` 要等：这一步什么也不写，
 *    不再交给 pi，直接进入第 5 步（有旧的一轮在停止的话，第 5 步在旧的一轮的 `turn_end` 之后）。
 * 3. T0：开始计 {@link ASSISTANT_ABORT_SETTLE_MS}。**起点是 T0，不是 `abort` 写出去或者得到回应的那一刻；`clear_queue` 有没有回应
 *    也不等。** **T0 时 pi 已经报告过 `agent_settled`、没有东西在跑**（比如这一轮正在探工作台、结局还没有发）：不等这段时间，`abort` 不用写，
 *    直接进入第 5 步，**pi 进程留着**。否则，在 T0 加这段时间之内 pi 报告了 `agent_settled`：进入第 5 步，**pi 进程留着**，下一轮接着用。到了 T0 加这段时间还没有 `agent_settled`
 *    （pi 卡住时，`clear_queue`、`abort` 都可能不回应）：结束 pi 进程，先关 stdin、发 SIGTERM，{@link ASSISTANT_PROCESS_KILL_GRACE_MS}
 *    之后还没有退出就 SIGKILL，进程退出之后进入第 5 步。pi 中止正在跑的命令、工作台上命令的进程树随连接断开结束，
 *    #539 第 6 题的实测：`abort` 0.04 到 0.08 秒回应，工作台上的命令 0.1 秒内消失。
 * 4. 没有送到的插话以**助手服务自己的记录**为准（见「插话」）：已经送到的不算，其余的（交给了 pi 但没有送到的，和助手服务自己留着、
 *    没有交给 pi 的）各发一条 `steer_dropped`。pi 的队列里只有文字、没有 `message_id`，`clear_queue` 的回应也是这样，所以它只用来
 *    核对条数（和助手服务认为还在 pi 队列里的条数对不上时记日志，仍以助手服务自己的记录为准）。`message_id` 是这句话的 ID，`message` 写明
 *    是哪句（引用原文，太长的截断）和「没有送到」；发 `turn_end` 时 `clear_queue` 还没有回应的，这些话可能其实已经送到了，写
 *    「没有确认送到」。
 * 5. 按收到的顺序发完每句没送到的插话的 `steer_dropped`，再发这一轮的 `turn_end`（结局是 `stopped`、`limit`，或者结束会话时的 `stopped`）。
 *
 * **最晚的时间**：正常的路径，从 T0 到发出 `turn_end` 最晚是 {@link ASSISTANT_ABORT_SETTLE_MS} 加 {@link ASSISTANT_PROCESS_KILL_GRACE_MS}
 * （SIGKILL 一发出进程就没了），再加助手服务内部的命令往返，余量是 {@link ASSISTANT_STOP_MARGIN_MS}。**硬上限是从 T0 起
 * {@link ASSISTANT_STOP_WAIT_MS}**：SIGKILL 之后进程仍然没有退出（不该发生）时，到了这个时间也照样发这一轮的 `turn_end`
 * （`steer_dropped` 写「没有确认送到」），不再等进程退出；这个进程没有退出之前一直算在活着的进程里，等在它后面的新一轮（上面「`prompt` 的判断」
 * 第 3 条）在同一时刻以 `failed` 结束。
 *
 * **控制面这一侧**：控制面从**发出 `abort` 的那一刻**（不是收到 202 的那一刻）起，等这一轮的 `turn_end` 最多 {@link ASSISTANT_STOP_WAIT_MS}
 * （它引用同一个常量）。两边起点的差是 `abort` 从发出到被助手服务收到的时间，平时几毫秒，正常的路径最晚 20 秒，余量 3 秒盖得住；只有
 * 起点的差超过余量、或者上面的硬上限，控制面才会先到点：到点没有等到 `turn_end`，控制面自己补一条 `stopped`（补插话的 `steer_dropped`，
 * 见「插话」），会话回到空闲；助手服务晚到的这一轮的事件，按「这一轮已经结束」丢掉。助手服务不知道项目，也不管这一轮停下之后
 * 哪个会话接着做。
 *
 * **控制面发出 `abort` 之后、这一轮的结局写下之前，用户又说的话，是新的一轮的开头，不是插话**：控制面把它排在这一轮后面（用项目里已有的
 * 排队），这一轮的结局（助手服务带回的，或者控制面自己补的）写下之后才为它发 `prompt`。所以「在停止 × `prompt`」那一格只有控制面等不到结局、
 * 自己补了结局之后才会走到。页面（544-C）照此显示：这句话在排队，不是插话。
 * **这句话按说话的时刻排进项目里已有的队列，不插队：项目里已经有别的会话在排的话，它排在它们后面，页面显示的「排在第几位」照这个算。**
 *
 * **用户点停止，是这个会话在做的一轮停掉、排着的话移出队列**（停止途中说了话、又点一次停止，就是撤掉那句话）。
 *
 * **不同轮次的 `turn_end` 不保证先后**（比如在停止的第 m 轮、等着的第 k 轮被中止，k 的 `turn_end` 立即发出，可能排在 m 的前面），读的一方按轮次认事件，不按先后。
 *
 * **前提和备选**：第 3 步里「`abort` 之后 pi 进程留着接着用」，依赖「模型输出到一半时 `abort`，之后同一个进程再发一轮照常做」。
 * #539 测过 `abort` 本身和 `abort` 之后再发一轮，没有测过**输出到一半时**的 `abort`：544-B 在写助手服务之前先补测这一条。
 * 不成立时，停止改成结束进程：第 2、3 步换成「T0 起直接关 stdin、SIGTERM、{@link ASSISTANT_PROCESS_KILL_GRACE_MS} 之后 SIGKILL，
 * 进程退出之后进入第 5 步」，下一轮重起进程并恢复会话。**这两种做法对控制面没有区别**：事件、结局、`steer_dropped`、
 * 最晚的时间（后一种只会更早）都一样，不用改这份协议，也不用和控制面那一半商量。
 *
 * **进程留着时，下一轮把 `prompt` 交给 pi 之前先 `clear_queue` 一次**，取回的丢掉、记日志。兜的是这个竞争：一句话的 `steer` 回应还没有回来时，
 * `clear_queue` 已经写出，这句话可能在清空之后才进 pi 的队列（pi 处理 `steer` 要先过一遍输入处理，`clear_queue` 是立刻执行的）；它在 `abort` 之后
 * 留在队列里，下一轮会被送给模型，而它的 `steer_dropped` 早就发过了。**544-B 先测这个竞争，和「怎么认『送到』」里的假设（一轮里除了这一轮的
 * `prompt`，pi 产生的 role=user 的消息都是插话；#539 第 7 题只测了一句插话、没有压缩上下文的情形）**。**退路**：这个竞争清不干净的话，停止改成
 * 结束进程（上面的备选：队列随进程消失，下一轮重起）；那条假设不成立的话，先停下、改协议再做。
 *
 * ## 插话（#544 起）
 *
 * 命令 {@link SteerCommandBody} 带 `turn`、`message_id`、`text`。
 *
 * **什么时候接受**：只有第 `turn` 轮「在做」才回 202，包括 pi 还没有拿到 `prompt`、或者还在等旧的一轮结束的时候：助手服务先自己留着，
 * `prompt` 交给 pi 之后按收到的顺序依次发 `steer`。其余都回 409 `no_turn_running`：没有一轮、第 `turn` 轮在停止或者已经结束、
 * `turn` 不是在做的那一轮。迟到的插话因此不会落进下一轮。**在停止的一轮回 409 有原因**：pi 在 `abort` 之后会继续执行还留在它队列里的
 * 消息，所以停止必须先 `clear_queue` 再 `abort`，而且从决定结束的那一刻起插话就不再交给 pi，这时收下的话没有地方可去。同一个
 * `message_id` 再来只算一次（回 202，不再多留一份）。
 *
 * **控制面等这一轮 `prompt` 的 202 之后才转发插话**：`prompt` 的回应回来之前用户说的插话，控制面先留着（`user_message` 照常写），202 之后按说的先后
 * 发 `steer`；`prompt` 没有得到 202（503、超时、连不上、别的 5xx）时，这些话各写一条 `steer_dropped`。助手服务不用为「插话先于 `prompt` 到」做任何事
 * （照旧回 409 `no_turn_running`）。
 *
 * **`steer_queue`**：接受之后助手服务**先发一份含它的 `steer_queue`**；`steer_queue` 是还没送到的完整列表，每次变化发一条取代上一条
 * （空列表也发），不持久。pi 自己的队列（`clear_queue` 的回应、`queue_update` 事件）里只有文字、没有 `message_id`：助手服务自己按交给 pi 的
 * 顺序记着每句话的 `message_id`、原文和有没有送到。
 *
 * **什么时候送到**（#539 第 7 题的实测，和 pi 的文档一致）：在当前这一步的工具调用做完之后、下一次调用模型之前。当前这一步是
 * `sfly run wait` 这类长命令时，要等它做完，所以页面写明「要马上停下用停止」。不做 pi 的 `follow_up`：进行中只有插话一种。
 * **连着发的几句一次送完**：助手服务启动 pi 时把插话的模式设成「一次全送」（pi 默认是每完成一次助手回复送一句，连着的两句会分到两次
 * 模型调用里）。理由：用户连着发两句纠正，模型应当一起看到；页面上「等待送达」的几句也一起变成已送达。这个模式对「送到」怎么认没有影响
 * （下面按顺序对，一次送完时每一句仍是各自的一条用户消息）。**544-B 先测这个模式**，有问题的话退回 pi 的默认模式，先改这一段。
 * 送到时助手服务不发 `user_message`（控制面收到这句话时已经写了），只发新的 `steer_queue`，这句话从列表里去掉。
 *
 * **怎么认「送到」**：助手服务把交给 pi 的每句话按交出的顺序记成一个队列；pi 每出现一条用户消息（`message_end`，`role` 是 `user`），
 * 队首那一句就算送到了，**按顺序对，不比较文字**（pi 会把 skill 命令和提示模板展开，用户消息的文字可能和插话原文不一样）；
 * **这一轮自己的 `prompt` 产生的那条用户消息（这一轮的第一条）不算**；不看 `queue_update` 的 `steering` 变空（`clear_queue` 之后它也会变空，
 * 两件事分不清）。pi 对 `steer` 的回应里 `disposition` 是 `handled` 的（这句话被扩展的输入处理器吃掉了，不进队列，也不会有用户消息）：
 * **当作没送到**：马上发一条 `steer_dropped`（`message` 写这句话被扩展处理了、没有送到模型），**之后**再发不含它的 `steer_queue`。现在没有扩展这样做，
 * 写明是为了以后不悄悄漏掉。**544-B 先测 `handled` 的实际表现**，**退路**：`disposition` 的取值或含义和这里写的不一致时，退到保守的做法：`steer` 的回应里没有说明这句话进了队列的，
 * 一律当作没送到、发 `steer_dropped`（宁可多说没送到，也不悄悄漏掉），再改这一条。
 *
 * **三种边界**：
 * - **最后一次模型回复不带工具调用时发的插话**：这次回复照常结束，pi 带着插话再请求一次模型，这一轮接着做，插话不丢，也不等到下一次
 *   `prompt`（实测假模型先等 4 秒才开始输出，所以测的是「模型还没开始输出」，不是「输出到一半」）。助手服务看到 pi 报告 `agent_settled`
 *   而插话还没有送到时（不该发生），按下面的不变式发 `steer_dropped`，再发 `turn_end`；
 * - **停止时还没送到的插话**：不送到模型，各发一条 `steer_dropped`（「停止一轮」第 4 步）；
 * - **连着发两句**：都留着，按收到的顺序一次送完（上面），每一句各有自己的 `message_id`，各是一条用户消息；相同的两句话靠顺序区分。
 *   #539 第 7 题只测了一句：**544-B 先测两句是不是各一条用户消息**。**退路**：不是的话，退回 pi 的默认模式（一次送一句，两句一定分在两次模型调用里、
 *   各是一条用户消息），先改「连着发的几句一次送完」那一段。
 *
 * **不变式**：每句回过 202 的插话，在这一轮的 `turn_end` **之前**，要么已经送到（出现了对应的用户消息，见「怎么认『送到』」），要么有一条带它的
 * `message_id` 的 `steer_dropped`（`handled` 的那一种也是）。**这一轮怎么结束都一样**：`completed`、`stopped`、`limit`、`failed`（连不上工作台、等不到旧的进程、起不来……）、
 * `model_unavailable`、`interrupted`。由它得出：
 * - **通用规则（任何结局下都一样）：一句话从 `steer_queue` 里消失，要么是送到了，要么助手服务已经先发了它的 `steer_dropped`。** 所以没送到的话的
 *   `steer_dropped` 一定排在不含它的 `steer_queue` 前面，也排在这一轮的 `turn_end` 前面：决定结束这一轮（`abort`、上限、`end`）之后助手服务不再发
 *   `steer_queue`；`agent_settled` 时还有话没送到、pi 进程退出、连不上工作台这些结局也一样，不能先发一份不含它的 `steer_queue`。
 * - **一轮的 `turn_end` 到的时候，最后一份 `steer_queue` 里还列着、又没有 `steer_dropped` 的话，算送到**：它是在决定结束之后、pi 处理 `clear_queue` 之前才送到的
 *   （助手服务自己的记录照常更新，只是不再对外发 `steer_queue`），所以既没有 `steer_dropped`，也没有一份不含它的 `steer_queue`。读的一方（控制面、页面）
 *   照此显示；刷新之后读库（`steer_queue` 不持久，只剩 `user_message` 和有没有 `steer_dropped`）得到的是同一个结果。没送到的话都已经有 `steer_dropped`。
 *   控制面自己补结局时这一条不适用：那时没有确认送到的话都补了 `steer_dropped`。
 * - **由控制面补这一轮的结局时**（助手服务没有回话、到点没有 `turn_end`、重启了……，不论补的是 `stopped`、`interrupted` 还是 `failed`）：
 *   控制面这一轮里**还没有确认送到、也还没有 `steer_dropped`** 的每一句插话，各补一条 `steer_dropped`（`message_id` 是这句话的 ID，
 *   `message` 写「没有确认送到」），排在补的 `turn_end` 前面。「这一轮里的插话」指控制面这一轮里写过 `user_message`（`steer` 为 true）的话，
 *   包括命令还没有得到回应的。**「确认送到」**：这句话在某一份 `steer_queue` 里出现过，之后又收到过一份不含它的 `steer_queue`，并且这句话没有
 *   `steer_dropped`（上面的通用规则：消失的话要么送到了，要么先有了 `steer_dropped`；`handled` 的先发 `steer_dropped`）。
 * - **`steer` 命令回 409，或者超时、连不上、5xx 之类没有得到 202**：控制面为这句话写一条 `steer_dropped`。409 写「没有送到」；超时、
 *   连不上是结果未知（助手服务可能已经收下了），写「没有确认送到」。不重试，也不当作新的一轮：用户在时间线上看到这句话没有送到，可以再说一次。
 *   助手服务收下之后又没有送到的话，之后可能再发一条同一句话的 `steer_dropped`：两条都表示这句话没有（确认）送到，**按 `message_id` 认，显示一次**。
 *
 * ## 结束会话（#544 起）
 *
 * `POST /sessions/:id/end`：这个会话不会再有新的一轮。**收到就回 202**，不等这一轮停下来，也不等进程退出（控制面的命令只等 10 秒，
 * 停一轮最长 {@link ASSISTANT_STOP_WAIT_MS}）。之后在后台按状态处理，见上面的表：没有一轮就直接关闭 pi 进程；有一轮在做，照「停止一轮」
 * 结束它（T0 是收到 `end` 的那一刻，结局 `stopped`，`reason` 写会话结束了），`turn_end` 照常发，**之后**关闭 pi 进程；在停止的，等它停完再关闭；
 * 在停止、又有一轮在等的，等的那一轮立即 `stopped`。重复调用无害，助手服务不认识的会话也是 202。
 * 关闭进程是关 stdin，宽限 {@link ASSISTANT_PROCESS_KILL_GRACE_MS} 之后 SIGKILL，释放进程槽位。`end` **不动中止记号**（它照常过期：`end`
 * 之前发出、还在路上的 `prompt` 靠它挡住），也**不删任何东西**：会话目录（pi 的会话文件、`events.jsonl`）和工作台上的工作区都留着。
 * **助手服务不记着收到过 `end`**（重启之后更不会知道）：`end` 之后来的、轮次比记号大的 `prompt` 照表处理（起一轮、照常做）；正确的控制面不会发出这样的 `prompt`。
 *
 * **控制面这一侧的先后**（写在同一处，两个人照着做）：
 * 1. 先停止这个会话正在做的一轮，**等到这一轮的结局**（助手服务带回的 `turn_end`，或者等了 {@link ASSISTANT_STOP_WAIT_MS} 之后自己补的）；排队中的话移出队列；
 * 2. **写 `session_ended`**，和「这个会话此刻没有一轮在做、没有在排队」的检查在同一个事务里：要么在这之前新的一轮已经开始了（结束的一方回头再停它，回到第 1 步），
 *    要么 `session_ended` 先写下，之后的发话回 409 `session_ended`。**写下之后控制面不再为这个会话发 `prompt` 和 `steer`**；在那之前发出、还在路上的 `prompt`
 *    由中止记号挡住（上面：`end` 不动记号）。
 * 3. 然后发 `end`。`end` 是尽力而为的收拾：发不出去（连不上、超时、5xx）时会话照样已经结束。这时助手服务那边这个会话的 pi 进程由什么收掉，照 dev 上实际的：
 *    进程数到了上限时关掉最久没有用的空闲进程（#545 会加空闲回收），除此之外留到助手服务重启（**标给 544-B / #545**：没有收到 `end` 的会话，进程留着不影响正确性，只占一个进程槽位）。
 *
 * ## 各部分的进度（#544 拆成几个 PR；写在这里的「dev 上现在」是 #618 合入之后的实现）
 *
 * | 说明 | 助手服务（#544 的助手服务那一半） | 控制面（#544 的控制面那一半） |
 * |---|---|---|
 * | 状态和命令的回应 | dev 上现在没有「在停止」这个状态：撞上记号的 `prompt` 除外（见「中止记号」一行），有一轮在（不论在做还是在停止，`abort` 之后进程还在退出时也一样）都回 409 `turn_running`。要做：按「一轮的状态」的表 | 假助手服务（`apps/server/test/support/fake-assistant.ts`）现在先判 409、后看记号，和助手服务相反；要做：照表，包括「旧的一轮过一会儿才结束」 |
 * | `steer` | dev 上现在没有这条路由（404）。要做：接受、留着、送到、`steer_queue`、`no_turn_running` | dev 上现在在做时发话回 409 `turn_running`。要做：写 `user_message`（`steer: true`）、转发（带 `turn`）、没有送到时的 `steer_dropped` |
 * | `end` | dev 上现在没有这条路由（404）。要做 | 要做：`POST /sessions/:id/end` 和「结束会话」里的先后（先停止并等到结局、再写 `session_ended`、再发 `end`）。dev 上没有 |
 * | 停止 | dev 上现在 `abort` 直接结束 pi 进程（先关 stdin、SIGTERM，{@link ASSISTANT_PROCESS_KILL_GRACE_MS} 之后 SIGKILL，进程退出之后发 `turn_end`）。要做：按「停止一轮」（`clear_queue`、`abort`、等 `agent_settled`、不行才结束进程；到了上限走同一条路） | dev 上现在等结局的时间是 `STOP_GRACE_MS`（13 秒：{@link ASSISTANT_PROCESS_KILL_GRACE_MS} 加控制面自己的 `STOP_MARGIN_MS`，数和协议里的 {@link ASSISTANT_STOP_MARGIN_MS} 不是同一个常量），从 `abort` 命令返回（收到 202，或者超时、连接断开这类结果未知）之后起算。要做：换成 {@link ASSISTANT_STOP_WAIT_MS}（23 秒）、从发出 `abort` 起算；自己补结局时补 `steer_dropped` |
 * | 中止记号 | dev 上现在：每个会话一个记号，留轮次最大的，10 分钟过期，总数 1000；`prompt` 先看记号，**轮次等于记号**的才挡住并取走记号，轮次比记号小的照常做（有一条测试固定了它：先中止第 5 轮、再中止第 3 轮，第 3 轮照常做完）；轮次比记号大、而且没有回 409 的才清掉记号（`#dropStaleAbortMark` 在判断 409 之后）；`abort` 只在轮次比助手服务记得的最近一轮大时才记（助手服务重启之后还没见过这个会话的轮次时也记）。要做：只增不减，轮次不大于记号的 `prompt` 都挡住、不取走记号，`abort` 一律提到 N（过期、总数上限不变）；那条测试跟着改 | 假助手服务要和这里一致 |
 * | 旧的一轮还在停止时来了新的一轮 | dev 上现在先看记号，再有一轮在（包括在停止）就回 409 `turn_running`。要做：登记、202、等旧的一轮结束再起，等不到以 `failed` 结束 | 不用为此多等 |
 * | 排队 | 不知道项目，不排队 | 要做：同一个项目一次只把一轮交给助手服务，其余在控制面排队 |
 */

/**
 * 助手服务结束 pi 进程时的宽限（毫秒）：先关 pi 的输入、发 SIGTERM，等进程自己退出，**宽限到了还没退出才 SIGKILL**；
 * 这一轮的 `turn_end` 在进程退出**之后**才发。#544 之前停止一轮就是直接走这一步，收到 `abort` 之后结局最晚在这么久
 * （外加命令往返）之后带回；#544 起停止先用 pi 的 `abort`，等 {@link ASSISTANT_ABORT_SETTLE_MS} 没有结果才走这一步
 * （最晚的时间见 {@link ASSISTANT_STOP_WAIT_MS}）。助手服务用它结束进程；控制面等结局的时间经 {@link ASSISTANT_STOP_WAIT_MS}
 * 引用它（dev 上现在控制面的 `STOP_GRACE_MS` 还直接引用它，见「各部分的进度」）。
 */
export const ASSISTANT_PROCESS_KILL_GRACE_MS = 10_000;

/**
 * #544 起：停止一轮时等 `agent_settled` 的最长时间（毫秒），**从决定结束这一轮的那一刻（「停止一轮」里的 T0）起算**，
 * 不是从 `abort` 写出去或者得到回应的那一刻起算；没等到就结束 pi 进程（{@link ASSISTANT_PROCESS_KILL_GRACE_MS}）。
 * #539 第 6 题的实测：`abort` 0.04 到 0.08 秒就回应，工作台上的命令 0.1 秒内消失，这个数是兜底：pi 不理 `abort` 时
 * 用户最多多等这么久。一轮到了上限走同一条路，用同一个数。
 */
export const ASSISTANT_ABORT_SETTLE_MS = 10_000;

/**
 * 停止一轮时，在 {@link ASSISTANT_ABORT_SETTLE_MS} 和 {@link ASSISTANT_PROCESS_KILL_GRACE_MS} 之外多留的余量（毫秒）：
 * 盖过两边起点的差（`abort` 从控制面发出到助手服务收到）和事件送到控制面的时间，以及助手服务内部的命令往返（经能力端口结束工作台上的命令、写结局）。
 * `clear_queue` 不等回应，不在余量里。
 */
export const ASSISTANT_STOP_MARGIN_MS = 3_000;

/**
 * 一轮从决定结束（「停止一轮」里的 T0：收到 `abort`、到了上限、收到 `end`）到发出这一轮的 `turn_end`，最晚的时间（毫秒）：
 * 等 `agent_settled` 的 {@link ASSISTANT_ABORT_SETTLE_MS}，加结束进程的宽限 {@link ASSISTANT_PROCESS_KILL_GRACE_MS}，
 * 加余量 {@link ASSISTANT_STOP_MARGIN_MS}。余量盖的是助手服务内部的命令往返（经能力端口结束工作台上的命令、写结局），
 * 和两边起点的差。**两处引用它，必须是同一个数，起点各写一句**：
 * - 助手服务：从**决定结束这一轮的那一刻**（T0）起算，到这个时间还没有发出 `turn_end` 的话，不再等进程退出，照样发；旧的一轮
 *   还在停止时来了新的一轮，新的一轮也最多等旧的一轮这么久，等不到就以 `failed` 结束（「一轮的状态」里「`prompt` 的判断」第 3 条）；
 * - 控制面：从**发出 `abort` 的那一刻**起算，等这一轮的结局（控制面的 `STOP_GRACE_MS`，#544 起换成它）：短了的话控制面先补一条
 *   `stopped`、会话回到空闲，用户马上再说一句，助手服务那边上一轮还挂着。
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
 * - 409 `turn_running`：开始一轮时这个会话有一轮「在做」（「一轮的状态」），而且 `prompt` 带的轮次比中止记号大；旧的一轮在停止时
 *   不是，那种情况回 202；轮次不大于记号的 `prompt` 也不是，回 202、以 `stopped` 结束；
 *   409 `no_turn_running`：插话时 `steer` 带的那一轮没有在做（没有一轮、在停止、已经结束、轮次对不上）。
 *   这两条和 dev 上现在的差别见「各部分的进度」；
 * - 503 `model_not_configured`、`model_unreachable`：模型没有配置或连不上，起不了（#548）；
 * - 503 `process_limit`：活着的 pi 进程数到了上限（#545）；
 * - 503 `start_failed`：其他原因，**登记之前**就知道起不了 pi 进程（比如启动命令不存在），`message` 写原因。
 *   **503 都只在登记之前决定**：回了 503 的 `prompt` 没有登记、不会有任何事件，控制面可以当作确定没开始；登记之后才发现起不了（起 pi 失败等）的，已经回了 202，
 *   这一轮以 `failed` 结束。别的 5xx、超时、连不上，对控制面是结果未知。
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
 *   到达时就能直接结束它。`abort` 先于这一轮的 `prompt` 到达也不要紧：中止记号已经提到了这一轮的轮次，这一轮的 `prompt`
 *   到了就直接以 `stopped` 结束（「一轮的状态」）；
 * - **一轮的事件可以先于这一轮 `prompt` 的回应到达控制面**：事件走事件流那条连接，回应走命令这条连接，两条连接谁先到没有保证
 *   （撞上中止记号立刻以 `stopped` 结束、一开始就失败，都是结局紧跟着 202）。控制面按轮次认事件（`turn` 等于会话此刻在做的那一轮），
 *   不按先后：这一轮的 `turn_end` 先到，照常落库、会话回到空闲，回应回来之后不会把它写回在做。所以助手服务**不用等回应送出之后才发
 *   这一轮的事件**；控制面也不能指望事件在回应之后才来。控制面这一侧的用例（#635）：`apps/server/test/session-assistant.test.ts` 的
 *   「一轮的 turn_end 比这一轮 prompt 的回应先到控制面（事件和回应走两条连接，先后没有保证）」，三种情形各一条；
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
 * `POST /sessions/:id/steer`：插话，助手服务把它交给 pi 的 `steer`。接受、送到、没有送到时发什么，整套规则在「插话」一节。字段：
 *
 * - `turn`：这句话是对第几轮说的（控制面在发出命令的那一刻在做的那一轮，和 `prompt` 里的 `turn` 是同一个）：**只有这一轮「在做」才接受**，
 *   否则 409 `no_turn_running`，迟到的插话不会落进下一轮；
 * - `message_id`：这句话的 ID（`user_message.message_id`），助手服务在 `steer_queue`、`steer_dropped` 里原样带回它，页面不靠文字对应；
 *   同一个 `message_id` 再来只算一次；
 * - `text`：这句话。
 */
export const SteerCommandBody = z.object({
	turn: z.int().min(1),
	message_id: z.uuid(),
	text: SessionMessageText,
});
export type SteerCommandBody = z.infer<typeof SteerCommandBody>;

/**
 * `POST /sessions/:id/abort`：中止第 `turn` 轮和比它更早的轮次（`turn` 是控制面给的轮次，和 `prompt` 里的 `turn` 是同一个）。
 * 不按「会话里有没有在做」、更不按时间去猜，按轮次：把**中止记号**提到 `turn`，在做的、轮次不大于 `turn` 的那一轮进入「在停止」；
 * 轮次比 `turn` 大的不动。每个状态下发生什么，见「一轮的状态」里的表；怎么停、最晚多久带回结局，见「停止一轮」。
 *
 * 回应总是 202，收到并决定了怎么办就回，**不等这一轮的 `turn_end`**。重复调用无害。控制面带的轮次：用户点停止时是此刻在做的那一轮；
 * `prompt` 超时（结果未知）之后补发的是那一轮；会话空闲时点停止带最近的那一轮（控制面这边它已经结束；助手服务那边还在做的话，照表停下，这正是这一次 `abort` 的用意）。
 * 别的轮次不受影响：停止的结局写下之后用户说的话，新的一轮（轮次更大）照常做；结局写下之前说的话，控制面排在这一轮后面（见「停止一轮」的控制面一侧）。
 */
export const AbortCommandBody = z.object({ turn: z.int().min(1) });
export type AbortCommandBody = z.infer<typeof AbortCommandBody>;

/**
 * 助手服务产生的会话事件：{@link SessionEventBody} 里由它产生的几种（`notice` 只有它产生的几种，`platform` 只有
 * `commit`），事件流里的 `event` 就是它。用户的话、一轮开始、排队、会话结束、`snapshot` 由控制面产生，不在其中；
 * 控制面补的 `turn_end`（`stopped`、`interrupted`、`failed`）和为这一轮里没有确认送到的插话补的 `steer_dropped`、`events_lost`、
 * `queue_cancelled`，以及插话命令回 409 或者没有得到 202 时那句话的 `steer_dropped`，也由控制面直接写，不经助手服务。
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
