import { z } from "zod";
import { SessionRef } from "../sessions.js";
import { EndedActionView } from "./actions.js";
import { endpoint, Timestamp } from "./contract.js";
import { FocusAnomaly, RunFocusItem } from "./run-focus.js";
import { LogLineView, NodeStatus, RunStatus } from "./runs.js";

/**
 * 运行状态（GLOSSARY「运行状态」）和运行摘要接口的契约（约定见 ./contract.ts）。
 *
 * **运行状态 `RunState`** 是一次运行在某一刻的整体情况：运行的状态、有没有被请求取消、到此刻为止的结果、最终失败的节点
 * （按失败的先后），以及每个链实例和它那条链上的每个节点的状态、尝试次数、起止时间和失败原因。它只有这一份定义，
 * 两处在用：
 *
 * - 运行摘要接口（`GET /runs/:id/summary`，给人和 AI 编程助手读结果）：运行状态加上只有接口给得起的内容
 *   （{@link RunReport}：完整的错误信息、失败任务的日志尾部、失败的动作、有异常的关注项）；
 * - 节点的输入（`${{ run.state }}`，docs/SEMANTICS.md）：时刻是任务派发的那一刻，`self` 标出引用它的节点，
 *   错误信息有长度上限（{@link RUN_STATE_LIMITS}），整份超过大小上限时去掉末尾失败节点的 `error.message`。
 *
 * 从运行的读取结果投影出它的纯函数是 `projectRunState`（../run-state.ts）。
 *
 * 所有字段总是存在，没有值时是空值（null、空数组）。不含任何节点的输入、输出、进度、日志、动作。以后要加字段只增不改：
 * 读它的节点代码（SDK 里是普通字典）和命令行都按「多出来的字段忽略」写。
 */

/**
 * 一个失败节点的错误（最近一次尝试的）。错误信息按这次运行的保密参数的值打码，和运行视图里看到的一样。
 */
export const RunStateError = z.object({
	/** 错误类型：node_error（节点代码抛出异常）、timeout、agent_lost、env_error、config_error。 */
	kind: z.string(),
	/**
	 * 失败原因的一行（和运行监控页头同一个取法，`errorHeadline`）：错误信息里第一行有内容的文字，去掉行首的异常模块路径；
	 * 没有错误信息时是空串。
	 */
	headline: z.string(),
	/**
	 * 异常信息本身，不含堆栈（执行器的失败结果里它们本来是分开的，两部分拼在一起存下以后用 `splitErrorText` 拆开）。
	 * 超过长度上限时截到上限、末尾是「…」，`message_truncated` 为 true。
	 */
	message: z.string(),
	/** `message` 被截断（超过长度上限，或整份状态超过大小上限被去掉）了。 */
	message_truncated: z.boolean(),
	/**
	 * 节点代码里出错的位置（一行文字，格式和任务被终止时的那一行相同：`模块.函数 第 N 行`）；没有时为 null。
	 * 位置由执行器算出、存在任务上（#471）；超时、Agent 失联、旧版本上报的和升级之前的任务没有位置，为 null。
	 */
	location: z.string().nullable(),
});

/** 一个链实例上的一个节点。 */
export const RunStateNode = z.object({
	node_id: z.string(),
	/** 节点的显示名称（子流程入口节点是子流程名称），取自运行绑定的场景版本；没有时为 null。 */
	display_name: z.string().nullable(),
	/**
	 * 节点的种类，场景文档里节点的 `kind`（`package`、`entry`、`subflow_entry`、`async`、`stop_subflow`……）；
	 * 场景里已移除种类的节点原样给出它的 `kind`，读它的一方遇到不认识的取值当作「别的种类」。
	 */
	kind: z.string(),
	/**
	 * 最近一次尝试的状态（取值同运行视图里的节点状态）；还没有尝试时为 `pending`，被跳过时为 `skipped`，没开始就被取消时为
	 * `cancelled`（这两种都没有尝试）。
	 */
	status: NodeStatus,
	/** 尝试次数，口径和运行视图相同（不含被跳过、没开始就被取消或停止的占位）。 */
	attempts: z.number().int().nonnegative(),
	/**
	 * 最近一次尝试开始执行、结束的时间（控制面时间）；还没开始、还没结束时为 null。没开始就被取消或停止的节点（含重试在排队时被
	 * 取消或停止的）：`started_at` 为 null，`ended_at` 是取消或停止的时间，不是上一次尝试的时间。
	 */
	started_at: Timestamp.nullable(),
	ended_at: Timestamp.nullable(),
	/** 只在 `status` 是 `failed` 时有：最近一次尝试的错误。被取消、被停止、被跳过的节点没有；超时的节点是 `failed`、`kind` 是 `timeout`。 */
	error: RunStateError.nullable(),
});

/** 一个链实例：主链，或由异步任务节点触发的子流程实例。 */
export const RunStateChain = z.object({
	id: z.string(),
	/** 链起点节点 ID（主链是入口节点，子流程是子流程入口节点）。 */
	chain_id: z.string(),
	/** 子流程名称（名称为空时是空字符串）；主链为 null。 */
	name: z.string().nullable(),
	/** 层数：主链是 0，主链触发的子流程是 1。 */
	depth: z.number().int().nonnegative(),
	/** 触发它的异步任务节点所在的链实例；主链为 null。 */
	parent_chain_instance_id: z.string().nullable(),
	/** 触发它的异步任务节点；主链为 null。异步任务节点成功只表示子流程实例已创建，子流程的结果看这个链实例自己的 `status`。 */
	async_node_id: z.string().nullable(),
	status: RunStatus,
	started_at: Timestamp,
	ended_at: Timestamp.nullable(),
	/** 这条链上的全部节点，按链上的顺序。 */
	nodes: z.array(RunStateNode),
});

export const RunState = z.object({
	run_id: z.string(),
	scenario: z.object({
		id: z.string(),
		/** 场景此刻的名称（名称不跟版本走）。 */
		name: z.string(),
		/** 运行绑定的场景版本号。 */
		version: z.number().int(),
	}),
	/**
	 * 运行此刻的状态。运行还没结束时是 `running`：引用它的节点自己还没结束，所以节点里看到的总是 `running`，
	 * 不能用它判断结果，看 `result_so_far`。
	 */
	status: RunStatus,
	/**
	 * 按运行结果的规则对「到此刻为止」算出的结果：已请求取消是 `cancelled`，否则有节点（或链）最终失败是 `failed`，
	 * 否则是 `success`；运行结束时的最终状态只会比它更坏（运行已经结束时它就是 `status`）。
	 */
	result_so_far: z.enum(["success", "failed", "cancelled"]),
	/** 触发人的昵称。 */
	triggered_by: z.string(),
	/** 经哪个 AI 编程助手触发；没有时为 null。 */
	triggered_via: z.string().nullable(),
	started_at: Timestamp,
	ended_at: Timestamp.nullable(),
	/** 取消请求；没有被请求取消时为 null。`forced_at`：清理期间再次取消（强制取消）的时间。 */
	cancel: z
		.object({
			requested_by: z.string(),
			/** 经哪个 AI 编程助手取消；没有时为 null。 */
			requested_via: z.string().nullable(),
			requested_at: Timestamp,
			forced_at: Timestamp.nullable(),
		})
		.nullable(),
	/**
	 * 最终失败的节点的 ID，按失败的先后（和控制台、运行记录、运行通知同一份顺序，GLOSSARY「第一个失败的节点」）：
	 * 第一项就是第一个失败的节点。一次运行里节点 ID 不重复，用它去链实例的 `nodes` 里找。
	 */
	failures: z.array(z.string()),
	/** 节点拿到这份状态时，引用它的那个节点；运行摘要接口里为 null。 */
	self: z
		.object({
			chain_instance_id: z.string(),
			node_id: z.string(),
		})
		.nullable(),
	/**
	 * 整份状态超过大小上限时，从 `failures` 的末尾开始去掉 `error.message`（那几个节点的 `message_truncated` 为 true），
	 * 直到放得下；去掉过时为 true。
	 */
	truncated: z.boolean(),
	/** 运行里已经创建的全部链实例，按层数、开始时间排序；还没被触发的子流程不在里面，看触发它的异步任务节点的状态。 */
	chains: z.array(RunStateChain),
});

/** 一个失败的任务（节点的一次失败的尝试）的日志尾部。 */
export const RunReportLogTail = z.object({
	/** 最后的若干行（行数有上限，`RUN_REPORT_LIMITS.logLines`），按时间从早到晚。 */
	lines: z.array(LogLineView),
	/** 前面还有更早的日志（用 `GET /tasks/:id/logs` 往前翻）。 */
	earlier: z.boolean(),
	/** 运行已超过保留期，日志已被清理（此时 `lines` 为空）。 */
	expired: z.boolean(),
	/**
	 * 日志读不到：控制面记着这个任务写过日志，日志文件里却读不出行（文件不在了、被移走了，运行还没过保留期）。
	 * 此时 `lines` 为空，但不是这个任务没有日志（没写过日志的任务 `lines` 也为空，`missing` 为 false）。
	 */
	missing: z.boolean(),
});

/**
 * 一个失败的任务：节点的一次失败的尝试。重试过的节点每次失败的尝试各一项（重试之后成功的节点，失败的那几次也算）；
 * 节点失败了、却没有失败的尝试（还没开始执行就失败）时，是它最后一次尝试，没有尝试时 `attempt` 和 `task_id` 为 null。
 */
export const RunReportFailedTask = z.object({
	chain_instance_id: z.string(),
	/** 链的子流程名称（名称为空时是空字符串）；主链为 null。 */
	chain: z.string().nullable(),
	node_id: z.string(),
	/** 节点的显示名称；没有时为 null。 */
	display_name: z.string().nullable(),
	/** 节点的种类（场景文档里节点的 `kind`）。 */
	kind: z.string(),
	/** 节点类型：包节点是「包名/节点名」，其他种类的节点为 null（用 `kind`）。 */
	node_type: z.string().nullable(),
	/** 这次尝试的序号；没有尝试时为 null。 */
	attempt: z.number().int().nullable(),
	/** 这个节点总共尝试了几次。 */
	attempts: z.number().int().nonnegative(),
	task_id: z.string().nullable(),
	/** 这次尝试的错误；没有错误信息时为 null。 */
	error: z
		.object({
			kind: z.string(),
			/** 失败原因的一行（同 {@link RunStateError} 的 `headline`）。 */
			headline: z.string(),
			/** 完整的错误信息：异常信息加堆栈，原文（已按保密参数的值打码）。 */
			detail: z.string(),
			/** 节点代码里出错的位置，同 {@link RunStateError} 的 `location`；没有时为 null。 */
			location: z.string().nullable(),
		})
		.nullable(),
	/** 日志尾部；没有任务（`task_id` 为 null）时为 null。 */
	logs: RunReportLogTail.nullable(),
});

/** 一个失败的动作，带上它所在的节点和尝试。 */
export const RunReportFailedAction = EndedActionView.extend({
	chain_instance_id: z.string(),
	node_id: z.string(),
	/** 节点的显示名称；没有时为 null。 */
	display_name: z.string().nullable(),
	attempt: z.number().int(),
	task_id: z.string(),
});

/** 有异常的关注项：关注项读数（`GET /runs/:id/focus`）里的一项，只留下认出它是哪一项、最新值和异常的字段。 */
export const RunReportAttentionItem = RunFocusItem.pick({
	position: true,
	node_id: true,
	display_name: true,
	chart: true,
	title: true,
	unit: true,
	source: true,
	latest: true,
}).extend({
	/** 异常的原因（规则见 `FocusAnomalyKind`）。 */
	anomaly: FocusAnomaly,
});

/** 摘要里各部分的数量上限。 */
export const RUN_REPORT_LIMITS = {
	/** 列出多少个失败的任务（其余只计数，`failed_tasks_total`）；这些任务才带日志尾部。 */
	failedTasks: 20,
	/** 每个失败的任务带多少行日志。 */
	logLines: 50,
	/** 列出多少个失败的动作（最近结束的在前）。 */
	failedActions: 10,
} as const;

/**
 * 运行摘要（类型名叫 RunReport：`RunSummary` 已经是运行列表里的一项）：运行状态（{@link RunState}）加上只有接口给得起的内容。`self` 总是 null，`truncated` 总是 false，
 * 错误信息不截断。
 */
export const RunReport = RunState.extend({
	/**
	 * 经哪个会话触发（会话令牌的请求，#547）：会话的 ID 和此刻的标题；不是会话触发的没有这个字段（和运行视图的 `session` 相同）。
	 * 只在运行摘要里：`RunState` 也是节点里 `${{ run.state }}` 看到的东西，不带它。
	 */
	session: SessionRef.optional(),
	/** 耗时（毫秒，控制面时间）；运行还没结束时为 null。 */
	duration_ms: z.number().int().nonnegative().nullable(),
	/**
	 * 失败的任务（节点最终失败的，和重试之后成功的节点上失败的那几次），按链实例的顺序、节点在链上的顺序、尝试的序号，
	 * 最多 `RUN_REPORT_LIMITS.failedTasks` 个；完整的错误信息和日志尾部在这里，`chains` 里的节点只有最近一次尝试的错误。
	 * 最终失败的节点按失败的先后看 `failures`。
	 */
	failed_tasks: z.array(RunReportFailedTask),
	/** 失败的任务的总数（超过上限时比 `failed_tasks` 的个数大，其余的看 `sfly run show`、`sfly run logs --failed`）。 */
	failed_tasks_total: z.number().int().nonnegative(),
	/**
	 * 失败的动作，最近结束的在前，最多 `RUN_REPORT_LIMITS.failedActions` 个：取每个任务动作摘要里最近失败的那几个
	 * （任务的动作摘要最多留 5 个），所以一个任务失败得很多时只看到最近的。
	 */
	failed_actions: z.array(RunReportFailedAction),
	/**
	 * 有异常的关注项（场景设了关注项时才有；没设时为空，不用执行中节点的主指标代替），按作者设定的顺序。
	 * 摘要只给最新值，要曲线用 `GET /runs/:id/focus`。
	 */
	attention_items: z.array(RunReportAttentionItem),
	/**
	 * 这次运行的保密值太多或太长（所有写法的总长超过上限），要打码的内容（日志、动作、输入输出、错误信息）整段盖住，
	 * 所以上面的错误信息、日志尾部、失败的动作看到的可能全是 `******`（不含任何值，#657）。和运行视图（`RunView`）的同名字段一样；
	 * 旧版本的控制面没有这个字段，读不到时当作 false。
	 */
	secrets_oversize: z.boolean().optional(),
});

export const runSummaryApi = {
	/**
	 * 一次运行的摘要：状态、耗时、最终失败的节点、每个失败的任务的错误（类型、失败原因一行、完整信息）和日志尾部、
	 * 失败的动作、有异常的关注项。判断一次运行「成功且结果对」先读它。读取走运行的统一读取（`readRuns`），
	 * 错误信息、参数里保密参数的值都已打码。运行不存在时 404。
	 */
	summary: endpoint({
		method: "GET",
		path: "/runs/:id/summary",
		summary: "读一次运行的摘要：状态、耗时、失败的节点和原因、日志尾部、失败的动作、有异常的关注项",
		effect: "read",
		resource: { kind: "run", target: { params: "id" } },
		client: true,
		key: ["runs", "summary"],
		params: z.object({
			/** 运行 id。 */
			id: z.string(),
		}),
		response: RunReport,
	}),
};

export type RunStateError = z.infer<typeof RunStateError>;
export type RunStateNode = z.infer<typeof RunStateNode>;
export type RunStateChain = z.infer<typeof RunStateChain>;
export type RunState = z.infer<typeof RunState>;
export type RunReportLogTail = z.infer<typeof RunReportLogTail>;
export type RunReportFailedTask = z.infer<typeof RunReportFailedTask>;
export type RunReportFailedAction = z.infer<typeof RunReportFailedAction>;
export type RunReportAttentionItem = z.infer<typeof RunReportAttentionItem>;
export type RunReport = z.infer<typeof RunReport>;
