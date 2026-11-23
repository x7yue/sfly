import { z } from "zod";
import { ParamType, STORED_NODE_KINDS } from "../orchestration-document.js";
import { RunLogNodesParam } from "../run-log-scope.js";
import { CurrentAction } from "./actions.js";
import { ClockOffsetView } from "./clock-offset.js";
import { download, endpoint, stream, Timestamp } from "./contract.js";
import { MetricIncrement } from "./metrics.js";
import { PreflightAgent } from "./orchestrations.js";
import { PresetView } from "./presets.js";

/**
 * 运行、任务日志与产物接口的契约（约定见 ./contract.ts）。
 * 运行视图由 apps/server/src/runs/run-read.ts 生成：参数、输入、输出、错误信息与进度文字里的
 * secret 值都已在控制面替换成掩码。
 */

/** 路径里的 ID：不是 UUID 时控制面返回 404（与找不到相同），所以这里只要求是字符串。 */
/** 运行 id（任务的日志、动作、产物接口里是任务 id）。 */
const IdParams = z.object({ id: z.string() });

export const RunStatus = z.enum(["running", "success", "failed", "cancelled"]);

/**
 * 任务（一次尝试）与节点的状态（docs/SEMANTICS.md §3.1）。节点另有 pending（还没有尝试）。
 * dispatched（界面写「准备中」）：已派发给 Agent，还在下载、安装节点包或启动执行器；
 * waiting：停止子流程节点在等被停止的子流程结束；stopped：所在子流程被停止子流程节点停止（docs/SEMANTICS.md §4.1，不算失败）。
 */
export const TaskStatus = z.enum([
	"queued",
	"dispatched",
	"running",
	"waiting",
	"success",
	"failed",
	"skipped",
	"cancelled",
	"stopped",
]);
export const NodeStatus = z.enum([...TaskStatus.options, "pending"]);

/**
 * 状态分组（控制面与前端共用，不要在别处再写一份）：
 * - ON_AGENT_STATUSES：由 Agent 负责、占用槽位的任务状态（准备中和执行中，有租约），也是还会上报指标的状态；
 * - ACTIVE_STATUSES：还没结束、正在推进的节点状态：排队中、准备中、执行中、等待中（「进行中的节点」）。
 */
export const ON_AGENT_STATUSES = ["dispatched", "running"] as const satisfies readonly z.infer<
	typeof TaskStatus
>[];
export const ACTIVE_STATUSES = [
	"queued",
	...ON_AGENT_STATUSES,
	"waiting",
] as const satisfies readonly z.infer<typeof TaskStatus>[];
export type OnAgentStatus = (typeof ON_AGENT_STATUSES)[number];
export type ActiveStatus = (typeof ACTIVE_STATUSES)[number];
export const isOnAgentStatus = (status: string): status is OnAgentStatus =>
	(ON_AGENT_STATUSES as readonly string[]).includes(status);
export const isActiveStatus = (status: string): status is ActiveStatus =>
	(ACTIVE_STATUSES as readonly string[]).includes(status);

/**
 * 错误：kind 是错误类型（node_error、timeout、agent_lost、env_error、config_error）；message 可能带堆栈（空行之后）。
 * location 是节点失败时出错的位置：节点代码里的那一行，写成「模块.函数 第 N 行」（SDK 的执行器取，堆栈不带执行器自己的帧）；
 * 不是节点自己出错、取不到位置、旧版本 Agent 或 SDK 上报的、升级之前的任务为 null。
 */
export const ErrorView = z.object({
	kind: z.string(),
	message: z.string(),
	location: z.string().nullable(),
});

/** 最新进度（ctx.progress），带两种时间（ADR 0018）。 */
export const TaskProgressView = z.object({
	current: z.number(),
	/** 总数；未知时为 null。 */
	total: z.number().nullable(),
	message: z.string(),
	/** 控制面时间：这次进度发生时的控制面时间；升级之前保存的进度没有记录，为 null。 */
	time: Timestamp.nullable(),
	/** Agent 时间：SDK 记录这次进度的时间，原样保存；没有上报时为 null。 */
	agent_time: Timestamp.nullable(),
});

/** 占着槽位的任务：哪个场景的哪个运行里哪个节点的第几次尝试（排队的尝试在等的槽位被它们占着）。 */
export const SlotHolderView = z.object({
	run_id: z.string(),
	orchestration_id: z.string(),
	/** 场景现在的名称（名称不跟版本走）。 */
	orchestration_name: z.string(),
	node_id: z.string(),
	/** 运行绑定的场景版本里这个节点的显示名称（子流程入口节点是子流程名称）；没有时不给。 */
	display_name: z.string().optional(),
	/** 子流程名称（没有名称的旧版本为子流程入口的节点 ID，名称为空时为空字符串）；任务在主链上为 null。 */
	chain_name: z.string().nullable(),
	attempt: z.number().int(),
	/** dispatched：下载、安装、启动中；running：执行器已启动。 */
	status: z.enum(["dispatched", "running"]),
	/** 执行器启动的时间；准备中为 null。 */
	started_at: Timestamp.nullable(),
});

/**
 * 排队中的尝试在等什么：等的那台 Agent 现在为什么没接它。控制面在读取的这一刻按派发的条件判断（在线、准备好环境、
 * 版本与控制面一致、有空闲槽位），不是尝试自己存下来的状态：Agent 上下线、槽位被占或释放不改变运行本身，
 * 所以运行视图没有变化的推送也会过时，页面和命令行在尝试排队期间定时重新读取。
 */
export const QueueWaitView = z.object({
	/** 等的是哪台 Agent（和尝试的 `agent` 相同）。 */
	agent: z.string(),
	/** 读取这一刻的控制面时间：排了多久、离线了多久、多久后排队超时都按它算（命令行不用自己的时钟）。 */
	now: Timestamp,
	/**
	 * offline：Agent 不在线（从没连上过，或已经断开）；preparing：在线，还在准备环境，不接任务；
	 * version_mismatch：版本与控制面不一致，不派新任务；slots_full：在线、已准备好，槽位都被占着（`holders`）；
	 * dispatching：在线、有空闲槽位，正在派发，马上会开始。
	 */
	state: z.enum(["offline", "preparing", "version_mismatch", "slots_full", "dispatching"]),
	/** offline：Agent 最后在线的时间（从没连上过时为 null）；preparing：开始准备环境的时间；其余状态为 null。 */
	since: Timestamp.nullable(),
	/** 排队超时的时间（超过它仍没有派发，任务以 env_error 失败）；没有设置排队超时时为 null。 */
	expires_at: Timestamp.nullable(),
	/** Agent 的槽位总数；Agent 不在线时为 null。 */
	slots: z.number().int().nullable(),
	/** slots_full：占着槽位的任务，按派发顺序；其余状态为空数组。只列读这个运行的人所在项目里的任务。 */
	holders: z.array(SlotHolderView),
	/** slots_full：同一台 Agent 上别的项目的任务占着多少个槽位（只有个数，不给场景、运行和节点）；其余状态为 0。 */
	other_project_holders: z.number().int(),
});

export const AttemptView = z.object({
	task_id: z.string(),
	attempt: z.number().int(),
	status: TaskStatus,
	agent: z.string().nullable(),
	/** 已解析的输入；派发前为 null。 */
	inputs: z.record(z.string(), z.unknown()).nullable(),
	outputs: z.record(z.string(), z.unknown()).nullable(),
	error: ErrorView.nullable(),
	queued_at: Timestamp,
	/** 执行器启动的时间；排队、准备中为 null。 */
	started_at: Timestamp.nullable(),
	ended_at: Timestamp.nullable(),
	/**
	 * 任务开始、结束时的时钟偏差（ADR 0018）：Agent 在执行器启动、得到结果那一刻的 Agent 时间减去当时的控制面时间；
	 * measured_at 加 offset_ms 就是那一刻的 Agent 时间。started_at / ended_at 仍是控制面收到消息的时刻。
	 * 旧版本 Agent、升级之前的任务、不在 Agent 上执行的节点、不是由 Agent 上报而结束的任务为 null。
	 */
	start_clock_offset: ClockOffsetView.nullable(),
	end_clock_offset: ClockOffsetView.nullable(),
	progress: TaskProgressView.nullable(),
	/** 执行中的尝试此刻在做的动作（见 CurrentAction）；没有时为 null，尝试结束后也为 null。 */
	current_action: CurrentAction.nullable(),
	/** 排队中（`status` 为 queued）的尝试在等什么；其余状态为 null。 */
	queue_wait: QueueWaitView.nullable(),
});

export const NodeRunView = z.object({
	node_id: z.string(),
	/** 节点的显示名称（子流程入口节点是子流程名称），取自运行绑定的场景版本；没有时不给。 */
	display_name: z.string().optional(),
	/** 运行绑定的版本是已移除的节点种类（ADR 0028）时，就是它当时的种类名：历史运行照常能看。 */
	kind: z.enum(STORED_NODE_KINDS),
	/**
	 * 最近一次尝试的状态；还没有尝试时为 pending，被跳过时为 skipped，没开始就被取消时为 cancelled
	 * （这两种都没有尝试记录）。
	 */
	status: NodeStatus,
	/** 包节点派发到的 Agent；内置节点为 null。 */
	agent: z.string().nullable(),
	outputs: z.record(z.string(), z.unknown()).nullable(),
	error: ErrorView.nullable(),
	attempts: z.array(AttemptView),
});

/** 链实例：主链（depth 0）或由异步任务节点派发的子流程实例。 */
export const ChainRunView = z.object({
	id: z.string(),
	/** 链起点节点 ID（主链是入口节点，子流程是子流程入口节点）。 */
	chain_id: z.string(),
	/** 子流程名称（没有名称的旧版本为子流程入口的节点 ID，名称为空时为空字符串）；主链为 null。 */
	name: z.string().nullable(),
	parent_chain_instance_id: z.string().nullable(),
	/** 派发这个子流程实例的异步任务节点；主链为 null。 */
	async_node_id: z.string().nullable(),
	depth: z.number().int(),
	status: RunStatus,
	params: z.record(z.string(), z.unknown()),
	started_at: Timestamp,
	ended_at: Timestamp.nullable(),
	/** 这条链上的节点，按链上的顺序。 */
	nodes: z.array(NodeRunView),
});

/**
 * 运行通知的状态（GLOSSARY「运行通知」）：队列里的消息是排队中、已送达、失败、已丢弃（机器人被删除）；
 * 运行结束时机器人已不存在的，没有进队列，是未发送。只有场景设置里选了机器人、而且满足触发条件的运行才有。
 */
export const RunNotificationState = z.object({
	status: z.enum(["queued", "delivered", "failed", "discarded", "not_sent"]),
	/** 通知发给哪个飞书机器人。 */
	bot: z.string(),
	/** 失败、已丢弃、未发送时的原因（中文，Webhook 地址已打码）；排队中和已送达为 null。 */
	reason: z.string().nullable(),
});

/** 运行用的运行预设，记的是触发时的情况：预设之后改名、删除都不影响。 */
export const RunPresetView = z.object({
	/** 预设的 ID；预设可能已被删除。 */
	id: z.string(),
	/** 触发时预设的名称。 */
	name: z.string(),
	/** 预设参数的名单：这些参数的值来自预设。 */
	params: z.array(z.string()),
});

/** 运行列表里一个运行用的运行预设：只有 ID 和触发时的名称（列表不带预设参数的名单）。 */
export const RunListPreset = RunPresetView.pick({ id: true, name: true });

export const RunView = z.object({
	id: z.string(),
	orchestration_id: z.string(),
	orchestration_version: z.number().int(),
	status: RunStatus,
	/** 触发人的昵称。 */
	triggered_by: z.string(),
	/** 经哪个 AI 编程助手触发（请求头 `x-sfly-client` 里的 `agent/<名称>`）；没有时为 null。只是标注，不是鉴权。 */
	triggered_via: z.string().nullable(),
	params: z.record(z.string(), z.unknown()),
	/** 触发时选用的运行预设；没有用预设时为 null。 */
	preset: RunPresetView.nullable(),
	started_at: Timestamp,
	ended_at: Timestamp.nullable(),
	/** 取消请求；没有被取消时为 null。forced_at：清理期间再次取消（强制取消）的时间。 */
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
	 * 运行通知的状态；没有发运行通知（场景没有选机器人、不满足触发条件、运行还没结束），
	 * 或者投递记录已过保留期被清理时为 null。
	 */
	run_notification: RunNotificationState.nullable(),
	/**
	 * 这次运行的保密值太多或太长（所有写法的总长超过上限）：控制面认不出每一处出现，这次运行里要打码的内容（日志、动作、
	 * 输入输出、错误信息）整段盖住，显示为 `******`（#517、#657）。不含任何值。控制台、命令行据此告诉使用者为什么看到的全是掩码，
	 * 缩短或减少保密参数的值之后重新运行。旧版本的控制面没有这个字段，读不到时当作 false。
	 */
	secrets_oversize: z.boolean().optional(),
	/** 按深度、开始时间排序。 */
	chains: z.array(ChainRunView),
});

/** 运行列表里的一项。 */
export const RunSummary = RunView.pick({
	id: true,
	orchestration_id: true,
	orchestration_version: true,
	status: true,
	triggered_by: true,
	triggered_via: true,
	started_at: true,
	ended_at: true,
}).extend({
	/** 触发时选用的运行预设；没有用预设时为 null。 */
	preset: RunListPreset.nullable(),
	/** 已请求取消、还在等待任务结束与清理（status 仍是 running，界面显示「取消中」）。 */
	cancelling: z.boolean(),
});

export const ParamDeclView = z.object({
	name: z.string(),
	type: ParamType,
	default: z.unknown().optional(),
	required: z.boolean().optional(),
	secret: z.boolean().optional(),
	/** 搭场景的人写的一行说明；敏感参数的说明照常给出，只有值打码。 */
	description: z.string().optional(),
});

/** 运行事件流上的 `progress` 事件：一个任务的最新进度。 */
export const ProgressEvent = z.object({
	run_id: z.string(),
	chain_instance_id: z.string(),
	node_id: z.string(),
	task_id: z.string(),
	progress: TaskProgressView,
});

/** 不能触发的一个原因；预检的警告（不阻断触发）也是这个结构。 */
export const PreflightProblem = z.object({
	code: z.string(),
	message: z.string(),
	node_id: z.string().optional(),
});

export const runsApi = {
	/**
	 * 触发前预检：最新版本号、入口参数声明、不能触发的原因（空表示可以触发）、
	 * 不阻断触发但值得留意的警告，
	 * 以及触发表单的检查清单要列出的锁定包版本与引用的 Agent（不在线、在准备环境都不阻止触发，任务会排队），
	 * 和场景的运行预设。
	 */
	preflight: endpoint({
		method: "GET",
		path: "/orchestrations/:id/preflight",
		summary: "触发前的预检：入口参数、不能触发的原因、引用的 Agent 和运行预设",
		effect: "read",
		resource: { kind: "scenario", target: { params: "id" } },
		client: true,
		key: ["runs", "preflight"],
		params: IdParams,
		response: z.object({
			/** 0 表示还没有版本。 */
			version: z.number().int(),
			/** 入口参数的声明（名称、类型、默认值、是否必填），触发表单按它生成。 */
			params: z.array(ParamDeclView),
			/** 不能触发的原因；空数组表示可以触发。 */
			problems: z.array(PreflightProblem),
			/** 不阻断触发、但值得留意的配置（例如异步任务节点没有给子流程的参数传值，而子流程里有节点用到了它）；没有版本、已归档时为空。 */
			warnings: z.array(PreflightProblem),
			/** 最新版本锁定的节点包版本（包名 → 版本）；没有版本时为空。 */
			packages: z.record(z.string(), z.string()),
			/** 最新版本引用的 Agent、在线状态与是否在准备环境，默认 Agent 在前；没有版本时为空。 */
			agents: z.array(PreflightAgent),
			/** 场景的运行预设，按名称排序（与 presetsApi.list 相同），`status` 对照这次检查用的最新版本。 */
			presets: z.array(PresetView),
		}),
	}),
	/** 一个场景的运行，按开始时间从新到旧（最多 200 条）。 */
	listForOrchestration: endpoint({
		method: "GET",
		path: "/orchestrations/:id/runs",
		summary: "列出一个场景的运行记录",
		effect: "read",
		resource: { kind: "scenario", target: { params: "id" } },
		client: true,
		key: ["runs", "by-orchestration"],
		params: IdParams,
		response: z.object({ runs: z.array(RunSummary) }),
	}),
	/**
	 * 触发场景的最新版本（201）。预检不通过时 400 `invalid_orchestration`（details 是原因列表），
	 * 参数不对时 400 `invalid_params`。
	 *
	 * 带上 `preset`（运行预设的 ID）时，预设参数取预设保存的值，`params` 只需要给其余的参数；预设在触发的事务里读取，
	 * 之后修改预设不影响这次运行。`params` 里给 secret 预设参数传了任何值（即使和预设相同，以免调用方猜测原值），或给其他预设参数传了不同的值
	 * （按 JSON 深比较）时 400 `preset_param_locked`（details 是 `{ param, preset }`：参数名和预设名），其他预设参数传相同的值照常触发。预设不存在或不属于这个场景时 404 `preset_not_found`；预设已失效（对照最新版本，见 PresetView 的 `status`）
	 * 时 409 `preset_invalid`（details 是问题清单，每项 `{ param, reason }`），不产生运行。
	 */
	trigger: endpoint({
		method: "POST",
		path: "/orchestrations/:id/runs",
		summary: "触发一个场景最新版本的一次运行（开始运行；可按运行预设取参数）",
		effect: "write",
		resource: { kind: "scenario", target: { params: "id" } },
		creates: "run",
		client: true,
		key: ["runs", "trigger"],
		params: IdParams,
		/** 入口参数和选用的运行预设；没有请求体等于 `{ params: {} }`。 */
		body: z
			.strictObject({
				params: z.record(z.string(), z.unknown()).default({}),
				/** 运行预设的 ID；不给就是不用预设。 */
				preset: z.string().optional(),
			})
			.default({ params: {} }),
		response: RunView,
	}),
	/** 运行视图；实时更新见 {@link runsApi.events}。 */
	get: endpoint({
		method: "GET",
		path: "/runs/:id",
		summary: "读一次运行的状态：各链、各节点的状态、输出、失败原因和每次尝试",
		effect: "read",
		resource: { kind: "run", target: { params: "id" } },
		client: true,
		key: ["runs", "detail"],
		params: IdParams,
		response: RunView,
	}),
	/**
	 * 取消整个运行（所有链）；清理期间再次调用即强制取消。返回取消后的运行视图；
	 * 已结束时 409 `run_not_running`。
	 */
	cancel: endpoint({
		method: "POST",
		path: "/runs/:id/cancel",
		summary: "取消一次运行；运行还没结束时再次调用即强制取消",
		effect: "write",
		resource: { kind: "run", target: { params: "id" } },
		client: true,
		key: ["runs", "cancel"],
		params: IdParams,
		response: RunView,
	}),
	/**
	 * 运行的实时推送（SSE）：连上时和运行或任何节点的状态变化时推送完整的运行视图（`run`），
	 * 任务进度更新时推送 `progress`（只含这一个任务的最新进度），执行中的任务新上报的指标点推送 `metrics`
	 * （每个任务每秒最多一条；断线期间错过的点用指标序列查询补齐）。
	 */
	events: stream({
		path: "/runs/:id/events",
		summary: "实时推送一次运行的状态、任务进度和指标",
		effect: "read",
		resource: { kind: "run", target: { params: "id" } },
		client: true,
		params: IdParams,
		events: { run: RunView, progress: ProgressEvent, metrics: MetricIncrement },
	}),
};

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
/** WARN 和 ERROR：关注项的日志异常、「其他警告与错误」都看这两级。 */
export const ALERT_LOG_LEVELS = [
	"warn",
	"error",
] as const satisfies readonly (typeof LOG_LEVELS)[number][];
export type AlertLogLevel = (typeof ALERT_LOG_LEVELS)[number];
/** 这一行日志的级别是不是 WARN 或 ERROR（{@link ALERT_LOG_LEVELS}）。 */
export const isAlertLevel = (level: (typeof LOG_LEVELS)[number]): level is AlertLogLevel =>
	(ALERT_LOG_LEVELS as readonly string[]).includes(level);
export const LOG_SOURCES = ["stdout", "stderr", "sdk", "agent", "system"] as const;
export const MAX_LOG_PAGE_LINES = 1000;

/**
 * 一行日志，带两种时间（ADR 0018）。日志文件是 JSONL，每行就是这个对象（字段顺序也相同：页面按它算字节偏移）；
 * 升级之前写入的行只有一个 `time`，读出时它是 `agent_time`，`time` 为 null。
 */
export const LogLineView = z.object({
	/** 任务内从 1 开始递增的序号，用来排序和去重。 */
	seq: z.number().int(),
	/** 控制面时间：这一行在 Agent 上被读到时的控制面时间，时间线定位和按时间范围筛选用它；未记录时为 null。 */
	time: Timestamp.nullable(),
	/** Agent 时间：原样保存，不做范围检查，只用于展示和对照；没有上报时为 null。 */
	agent_time: Timestamp.nullable(),
	/** agent：Agent 自己写入的提示行（Agent 时间跳变）；system：控制面写入的截断标记。 */
	source: z.enum(LOG_SOURCES),
	level: z.enum(LOG_LEVELS),
	/** secret 参数的值已替换成掩码。 */
	text: z.string(),
});

/** 逗号分隔的取值列表（请求侧解析成数组）。 */
const csv = <const T extends readonly [string, ...string[]]>(values: T) =>
	z
		.string()
		.transform((s) => s.split(",").map((v) => v.trim()))
		.pipe(z.array(z.enum(values)));

const ByteOffset = z.coerce.number().int().min(0);
/** 查询参数：空字符串等于没给。 */
const blankAsMissing = <S extends z.ZodType>(schema: S) =>
	z.preprocess((v) => (v === "" ? undefined : v), schema.optional());
/** 只要这些级别，逗号分隔。 */
const LevelsParam = blankAsMissing(csv(LOG_LEVELS));

export const LogPageQuery = z
	.object({
		/** 往前翻页：读这个字节偏移之前的行（默认文件末尾）。 */
		before: blankAsMissing(ByteOffset),
		/** 往后翻页：读这个字节偏移之后的行。不能与 before 同时给。 */
		after: blankAsMissing(ByteOffset),
		/** 一页最多多少行（默认 200）。 */
		limit: z.coerce.number().int().min(1).max(MAX_LOG_PAGE_LINES).default(200),
		/** 只要这些级别，逗号分隔。 */
		level: LevelsParam,
		/** 只要这些来源，逗号分隔。 */
		source: blankAsMissing(csv(LOG_SOURCES)),
		/**
		 * 定位到这个时刻（控制面时间）：返回包含那一刻的一页，前后各取一半（不足的一侧由另一侧补满），
		 * 响应的 `locate` 写明那一刻的位置和有没有正好对应的行。不能与 before、after 同时给。
		 */
		at: blankAsMissing(Timestamp),
	})
	.refine((q) => q.before === undefined || q.after === undefined, {
		message: "before 与 after 不能同时给",
	})
	.refine((q) => q.at === undefined || (q.before === undefined && q.after === undefined), {
		message: "at 不能与 before、after 同时给",
	});

/**
 * 按时刻定位（`at`）的结果。「正好对应」：行的控制面时间与 `at` 相差不超过 50 毫秒（含），并且这个范围里只有这一行；
 * 有几行时分不出是哪一笔的，算没有。没有控制面时间的旧行从不算。判断只在筛选（`level`、`source`）之后的行里做，没有符合的行就是没有。
 */
export const LogLocate = z.object({
	/**
	 * 那一刻在日志文件里的位置：这个字节偏移之前的行，控制面时间都早于 `at`（旧行没有控制面时间，算在前面）；
	 * 这个偏移起的行都不早于 `at`。晚于最后一行时是日志文件的大小，没有日志时是 0。
	 */
	at_offset: z.number().int(),
	/** 正好对应那一刻的行的序号；没有这样的行时为 null，页面改为在 `at_offset` 的位置标出这一刻。 */
	exact_seq: z.number().int().nullable(),
});

export const LogPage = z.object({
	task_id: z.string(),
	/** offset：这一行在日志文件中的字节偏移。 */
	lines: z.array(LogLineView.extend({ offset: z.number().int() })),
	/** 本页扫描范围 [start, end)：往前翻页用 `before=start`，往后翻页用 `after=end`。 */
	start: z.number().int(),
	end: z.number().int(),
	/** 读取时的文件大小。 */
	size: z.number().int(),
	/** 已写入的最大序号：实时流用 `after_seq` 从这里接上。 */
	last_seq: z.number().int(),
	/** 日志超过大小上限被截断。 */
	truncated: z.boolean(),
	/** 运行已超过保留期、日志已被清理（此时是空页）。 */
	expired: z.boolean(),
	/** 请求带了 `at` 时的定位结果；`end` 小于 `size` 说明这一页之后还有行，没带 `at` 时为 null。 */
	locate: LogLocate.nullable(),
});

/** 合并日志里一行的来源：它是哪个节点的哪一次尝试（任务）输出的。 */
export const LogOrigin = z.object({
	task_id: z.string(),
	chain_instance_id: z.string(),
	/** 所在子流程的名称（与运行视图里链的 name 相同）；主链为 null。 */
	subflow: z.string().nullable(),
	node_id: z.string(),
	attempt: z.number().int(),
});

/**
 * 合并日志里一行排序要用、行本身没有的信息（run-log-order.ts）：由控制面按这一行所在的任务填上，
 * 所以只凭行就能和别的行比较先后（前端插入实时行时不必查运行视图）。
 */
export const RunLogTaskOrder = z.object({
	/** 所在链路实例的层级（主链为 0）与开始时间：控制面时间相同时，链按层级、开始时间、链路实例 ID 排。 */
	chain_depth: z.number().int(),
	chain_started_at: Timestamp,
	/** 节点在场景版本里这条链上的位置，从 0 开始：同一条链上按它排。 */
	node_index: z.number().int(),
	/** 任务开始时间（还没开始时是排队时间）：没有控制面时间的旧行按它排。 */
	task_started_at: Timestamp,
});

/** 按运行合并的一行：任务日志里的一行，加上它的来源和排序要用的信息。 */
export const RunLogLine = LogLineView.extend(LogOrigin.shape).extend(RunLogTaskOrder.shape);

/** 按运行分页的游标：不透明字符串，由上一页的 before / after 原样传回。 */
const RunLogCursor = z.string();

/**
 * 按运行的实时推送的位置（#225）：不透明字符串，记录范围内每个任务已经推送到的序号。
 * 首次连接用分页返回的 `live_after`，之后每个事件的 ID 都是这个格式（断线重连时经 `Last-Event-ID` 请求头带回）。
 */
const RunLogLiveCursor = z.string();

/**
 * 按运行读取日志的范围参数：分页、实时推送（#225）、下载（#226）共用。
 * 不给 `nodes` 是全部节点；给了空字符串是没有节点（写法与判断函数见 run-log-scope.ts）。
 */
export const RunLogScopeQuery = z.object({
	/** 只看这些节点的日志，写法 `链路实例 ID:节点 ID,节点 ID;…`；不给是全部节点，给空字符串是没有节点。 */
	nodes: RunLogNodesParam.optional(),
});

/** 按运行读取日志的级别参数：分页与实时推送共用（下载不受级别筛选影响）。 */
export const RunLogLevelQuery = z.object({
	/** 只要这些级别的日志，逗号分隔（例如 `warn,error`）；不给是全部级别。 */
	level: LevelsParam,
});

export const RunLogPageQuery = z
	.object({
		/** 往前翻页：读这个游标之前的行。不给 before 和 after 时读最新的一页。 */
		before: blankAsMissing(RunLogCursor),
		/** 往后接续：读这个游标之后的行。不能与 before 同时给。 */
		after: blankAsMissing(RunLogCursor),
		/** 一页最多多少行（默认 200）。 */
		limit: z.coerce.number().int().min(1).max(MAX_LOG_PAGE_LINES).default(200),
		...RunLogScopeQuery.shape,
		...RunLogLevelQuery.shape,
	})
	.refine((q) => q.before === undefined || q.after === undefined, {
		message: "before 与 after 不能同时给",
	});

/**
 * 一次运行全部任务的日志合并成的一页（没选中节点时的日志视图，#220）。排序规则见 docs/ARCHITECTURE.md §6.3
 * 与 run-log-order.ts：同一个任务内按 seq，不同任务之间按控制面时间归并；时间相同时按链、节点、尝试的固定顺序；
 * 没有控制面时间的旧行用任务开始时间。比较先后要用的信息每行都带着（{@link RunLogTaskOrder}）。
 *
 * 游标记录每个任务读到的字节偏移：拿到这一页之后才开始的任务不在游标里，往前翻页时视为之前没有内容，往后接续时从头读。
 * 单次请求的扫描量有上限（所有任务分摊），所以一页可能不满 limit 行，筛选级别时甚至可能一行都没有；
 * 这不表示读到了开头或末尾，看 `reached_start` / `reached_end`，没到就用 `before` / `after` 接着读。
 *
 * 范围（`nodes`）和级别（`level`）在服务端执行，游标只对同一组范围和级别有效：换了范围或级别要从最新一页重新读
 * （新纳入范围的任务不在游标里，往前翻会漏掉它们）。
 */
export const RunLogPage = z.object({
	run_id: z.string(),
	/** 往前翻页时是游标之前（不给游标时是全部）的最后 limit 行，往后接续时是游标之后的前 limit 行，按上面的顺序。 */
	lines: z.array(RunLogLine),
	/** 读这一页之前的行：下一次往前翻页的 before。 */
	before: RunLogCursor,
	/** 读这一页之后的行：往后接续的 after。 */
	after: RunLogCursor,
	/** before 之前已经没有任何行（这一页之前就是运行的开头）。 */
	reached_start: z.boolean(),
	/**
	 * after 之后已经没有任何行（读取的那一刻）。往后接续时一页同样可能不满甚至为空，没到末尾就用 after 接着读；
	 * 之后写入的行用 after 再读或由实时推送送达。
	 */
	reached_end: z.boolean(),
	/**
	 * 实时流起点：读这一页那一刻范围内每个任务已写入的位置。最新一页的这个值就是实时推送（`runEvents`）的 `after`：
	 * 之后写入的行（包括之后才开始的任务）都由实时推送送达，与这一页和往前翻到的页合起来不重复、不遗漏。
	 */
	live_after: RunLogLiveCursor,
	/** 日志超过大小上限被截断的任务，按运行视图里的顺序。 */
	truncated_tasks: z.array(LogOrigin),
	/** 运行已超过保留期、日志已被清理（此时是空页）。 */
	expired: z.boolean(),
});

/**
 * 按运行下载的合并日志（JSONL）里的一行（#226）：任务日志里的一行，加上它的来源。两种时间都有（升级之前写入的行补齐：
 * `time` 为 null、`agent_time` 是当时记的 Agent 时间），不带排序用的字段（顺序已经体现在行的先后上）。
 * 行的顺序与合并视图相同，见 {@link RunLogPage}。
 */
export const RunLogDownloadRow = LogLineView.extend(
	LogOrigin.pick({ task_id: true, subflow: true, node_id: true, attempt: true }).shape,
);

/**
 * 按运行实时推送的一批新写入的行（`GET /runs/:id/logs/events` 的 `logs` 事件），格式与分页相同。
 * 一批里可能有多个任务的行，同一任务内按 seq；断线后补发的行（晚到的行）可能比已推送的别的任务的行更早，
 * 收到后按排序键（run-log-order.ts）插到对应位置。
 */
export const RunLogChunk = z.object({
	lines: z.array(RunLogLine),
});

/** 实时推送的一批行（`GET /tasks/:id/logs/events` 的 `logs` 事件）；offset 是第一行的字节偏移。 */
export const LogChunk = z.object({
	task_id: z.string(),
	lines: z.array(LogLineView),
	offset: z.number().int(),
});

export const logsApi = {
	/** 按字节偏移分页读取一个任务的日志（服务端按级别、来源筛选）。 */
	page: endpoint({
		method: "GET",
		path: "/tasks/:id/logs",
		summary: "分页读一个任务的日志（节点打印的输出），可按级别、来源筛选",
		effect: "read",
		resource: { kind: "task", target: { params: "id" } },
		client: true,
		key: ["logs", "page"],
		params: IdParams,
		query: LogPageQuery,
		response: LogPage,
	}),
	/**
	 * 日志的实时推送（SSE）：事件 `logs` 是新写入的一批行，`after_seq` 是已经读到的最大序号
	 * （从分页的 last_seq 接上，断线重连时按 `Last-Event-ID` 请求头续传）。
	 */
	events: stream({
		path: "/tasks/:id/logs/events",
		summary: "实时推送一个任务的日志",
		effect: "read",
		resource: { kind: "task", target: { params: "id" } },
		client: true,
		params: IdParams,
		query: z.object({
			/** 已经读到的最大序号（分页响应的 `last_seq`）：只推送它之后写入的行。 */
			after_seq: z.string().optional(),
		}),
		events: { logs: LogChunk },
	}),
	/** 下载原始日志（JSONL，只含请求时已写入的内容）；运行已过保留期时 410 `expired`。 */
	download: download({
		path: "/tasks/:id/logs/download",
		summary: "下载一个任务的完整日志（文件）",
		effect: "read",
		resource: { kind: "task", target: { params: "id" } },
		client: true,
		params: IdParams,
		contentType: "application/x-ndjson",
	}),
	/** 一次运行全部任务的日志合并分页读取（最新一页，或用游标往前翻、往后接续）；运行不存在时 404。 */
	runPage: endpoint({
		method: "GET",
		path: "/runs/:id/logs",
		summary: "把一次运行里各节点的日志（打印的输出）按时间合并，分页读",
		effect: "read",
		resource: { kind: "run", target: { params: "id" } },
		client: true,
		key: ["logs", "run-page"],
		params: IdParams,
		query: RunLogPageQuery,
		response: RunLogPage,
	}),
	/**
	 * 下载一次运行（范围内）合并后的日志：JSONL，每行是 {@link RunLogDownloadRow}，顺序与合并视图相同，
	 * 只含请求时已写入的内容，不受级别筛选影响；运行已过保留期时 410 `expired`，运行不存在时 404。
	 */
	runDownload: download({
		path: "/runs/:id/logs/download",
		summary: "下载一次运行的合并日志（文件）",
		effect: "read",
		resource: { kind: "run", target: { params: "id" } },
		client: true,
		params: IdParams,
		query: RunLogScopeQuery,
		contentType: "application/x-ndjson",
	}),
	/**
	 * 按运行的实时推送（SSE，#225）：范围（`nodes`）内全部任务新写入的行，包括订阅之后才开始的任务和尝试，
	 * 只推送 `level` 里的级别；范围和级别要与读历史时相同。`after` 用最新一页的 `live_after`。
	 *
	 * - `logs`：一批新行；事件 ID 是推送到的位置（不透明），断线重连时经 `Last-Event-ID` 请求头带回
	 *   （API 客户端的订阅自动带上），控制面只补发之后的行，不重复也不遗漏。
	 * - `reload`：要补发的行太多（超过浏览器保留的 5000 行），不逐行补发：从最新一页重新读，再用新的 `live_after` 连接。
	 *
	 * 运行不存在时 404，`after` 不是 `live_after` 或事件 ID 时 400。
	 */
	runEvents: stream({
		path: "/runs/:id/logs/events",
		summary: "实时推送一次运行的合并日志",
		effect: "read",
		resource: { kind: "run", target: { params: "id" } },
		client: true,
		params: IdParams,
		query: z.object({
			/** 实时流的起点：最新一页的 `live_after`，断线重连时是上一个事件的 ID。 */
			after: blankAsMissing(RunLogLiveCursor),
			...RunLogScopeQuery.shape,
			...RunLogLevelQuery.shape,
		}),
		events: { logs: RunLogChunk, reload: z.object({}) },
	}),
};

export const ArtifactView = z.object({
	/** 产物目录内的相对路径（`/` 分隔）。 */
	name: z.string(),
	size: z.number().int(),
	sha256: z.string(),
	/** 上传时间（控制面时间）。 */
	created_at: Timestamp,
	/** 文件在 Agent 上的修改时间（Agent 时间）；Agent 没有上报时为 null（未记录）。 */
	agent_modified_at: Timestamp.nullable(),
	/** 对 Agent 可见的完整下载地址（节点输出里的产物引用）；浏览器用 `/api/tasks/:id/artifacts/<name>`。 */
	url: z.string(),
});

/** 上传产物的请求头：文件在 Agent 上的修改时间（Agent 时间，Unix 毫秒）。旧版本 Agent 不带。 */
export const AGENT_MODIFIED_MS_HEADER = "x-sfly-agent-modified-ms";

const ArtifactParams = z.object({
	/** 任务 id。 */
	id: z.string(),
	/** 产物的名称（上传时的路径，可以带 `/` 分隔的目录）。 */
	"*": z.string(),
});

export const artifactsApi = {
	/** 一个任务的产物；运行已超过保留期被清理时 expired 为 true、列表为空。 */
	list: endpoint({
		method: "GET",
		path: "/tasks/:id/artifacts",
		summary: "列出一个任务上传的产物文件",
		effect: "read",
		resource: { kind: "task", target: { params: "id" } },
		client: true,
		key: ["artifacts", "list"],
		params: IdParams,
		response: z.object({
			task_id: z.string(),
			artifacts: z.array(ArtifactView),
			/** 已过保留期：数据已被清理。 */
			expired: z.boolean(),
		}),
	}),
	/**
	 * Agent 上传一个产物（201）：请求体是文件内容（原始字节，不在契约里）；`*` 是产物目录内的相对路径，
	 * 每个路径段单独百分号编码。`x-sfly-agent-modified-ms` 请求头是文件在 Agent 上的修改时间，可以不带。配置了注册令牌时需要 `Authorization: Bearer <token>`，否则 401 `unauthorized`；
	 * 这个任务已上传的加上这个文件超过单个任务的产物合计上限（`SFLY_ARTIFACT_LIMIT_MB`，随任务下发给 Agent）时 413，
	 * 请求带了 `Content-Length` 的在读请求体之前就拒绝；错误信息写明这个文件多大、这个任务已上传多少、上限多少（#477）。
	 */
	upload: endpoint({
		method: "PUT",
		path: "/tasks/:id/artifacts/*",
		summary: "上传一个任务的产物文件（请求体是原始字节，Agent 用）",
		effect: "write",
		resource: { kind: "task", target: { params: "id" } },
		client: false,
		key: ["artifacts", "upload"],
		params: ArtifactParams,
		upload: true,
		response: ArtifactView,
	}),
	/** 下载一个产物（attachment）；运行已过保留期被清理时 410 `expired`。 */
	download: download({
		path: "/tasks/:id/artifacts/*",
		summary: "下载一个任务的一个产物文件",
		effect: "read",
		resource: { kind: "task", target: { params: "id" } },
		client: true,
		params: ArtifactParams,
		contentType: "application/octet-stream",
	}),
};

export type RunStatus = z.infer<typeof RunStatus>;
export type TaskStatus = z.infer<typeof TaskStatus>;
export type NodeStatus = z.infer<typeof NodeStatus>;
export type ErrorView = z.infer<typeof ErrorView>;
export type TaskProgressView = z.infer<typeof TaskProgressView>;
export type SlotHolderView = z.infer<typeof SlotHolderView>;
export type QueueWaitView = z.infer<typeof QueueWaitView>;
export type AttemptView = z.infer<typeof AttemptView>;
export type NodeRunView = z.infer<typeof NodeRunView>;
export type ChainRunView = z.infer<typeof ChainRunView>;
export type RunNotificationState = z.infer<typeof RunNotificationState>;
export type RunPresetView = z.infer<typeof RunPresetView>;
export type RunListPreset = z.infer<typeof RunListPreset>;
export type RunView = z.infer<typeof RunView>;
export type RunSummary = z.infer<typeof RunSummary>;
export type ParamDeclView = z.infer<typeof ParamDeclView>;
export type PreflightProblem = z.infer<typeof PreflightProblem>;
export type LogLineView = z.infer<typeof LogLineView>;
export type LogLocate = z.infer<typeof LogLocate>;
export type LogPage = z.infer<typeof LogPage>;
export type LogChunk = z.infer<typeof LogChunk>;
export type LogOrigin = z.infer<typeof LogOrigin>;
export type RunLogTaskOrder = z.infer<typeof RunLogTaskOrder>;
export type RunLogLine = z.infer<typeof RunLogLine>;
export type RunLogPage = z.infer<typeof RunLogPage>;
export type RunLogDownloadRow = z.infer<typeof RunLogDownloadRow>;
export type RunLogChunk = z.infer<typeof RunLogChunk>;
export type ProgressEvent = z.infer<typeof ProgressEvent>;
export type ArtifactView = z.infer<typeof ArtifactView>;
