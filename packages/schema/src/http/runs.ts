import { z } from "zod";
import { type OrchestrationNode, ParamType } from "../orchestration-document.js";
import { download, endpoint, stream, Timestamp } from "./contract.js";
import { MetricIncrement } from "./metrics.js";
import { ReferencedAgent } from "./orchestrations.js";

/**
 * 运行、任务日志与产物接口的契约（约定见 ./contract.ts）。
 * 运行视图由 apps/server/src/engine/run-queries.ts 生成：参数、输入、输出、错误信息与进度文字里的
 * secret 值都已在控制面替换成掩码。
 */

/** 路径里的 ID：不是 UUID 时控制面返回 404（与找不到相同），所以这里只要求是字符串。 */
const IdParams = z.object({ id: z.string() });

const NODE_KINDS = [
	"entry",
	"subflow_entry",
	"async",
	"timer",
	"sleep",
	"package",
] as const satisfies readonly OrchestrationNode["kind"][];

export const RunStatus = z.enum(["running", "success", "failed", "cancelled"]);

/**
 * 任务（一次尝试）与节点的状态（docs/SEMANTICS.md §3.1）。节点另有 pending（还没有尝试）。
 * dispatched：已派发给 Agent，还在下载、安装节点包或启动执行器；waiting：定时 / Sleep 节点在等唤醒时间。
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
]);
export const NodeStatus = z.enum([...TaskStatus.options, "pending"]);

/**
 * 状态分组（控制面与前端共用，不要在别处再写一份）：
 * - ON_AGENT_STATUSES：由 Agent 负责、占用槽位的任务状态（派发阶段和执行阶段，有租约），也是还会上报指标的状态；
 * - ACTIVE_STATUSES：还没结束、正在推进的节点状态：排队、派发中、执行中、等待唤醒（「正在执行的节点」）。
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

/** 错误：kind 是错误类型（node_error、timeout、agent_lost、env_error、config_error）；message 可能带堆栈（空行之后）。 */
export const ErrorView = z.object({ kind: z.string(), message: z.string() });

/** 最新进度（ctx.progress）；time 是 SDK 记录的时间。 */
export const TaskProgressView = z.object({
	current: z.number(),
	/** 总数；未知时为 null。 */
	total: z.number().nullable(),
	message: z.string(),
	time: Timestamp,
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
	/** 执行器启动的时间（定时 / Sleep 节点是开始等待的时间）；排队、派发阶段为 null。 */
	started_at: Timestamp.nullable(),
	ended_at: Timestamp.nullable(),
	/** 定时 / Sleep 节点的唤醒时间；其他节点为 null。 */
	wake_at: Timestamp.nullable(),
	progress: TaskProgressView.nullable(),
});

export const NodeRunView = z.object({
	node_id: z.string(),
	kind: z.enum(NODE_KINDS),
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

export const RunView = z.object({
	id: z.string(),
	orchestration_id: z.string(),
	orchestration_version: z.number().int(),
	status: RunStatus,
	triggered_by: z.string(),
	params: z.record(z.string(), z.unknown()),
	started_at: Timestamp,
	ended_at: Timestamp.nullable(),
	/** 取消请求；没有被取消时为 null。forced_at：清理期间再次取消（强制取消）的时间。 */
	cancel: z
		.object({
			requested_by: z.string(),
			requested_at: Timestamp,
			forced_at: Timestamp.nullable(),
		})
		.nullable(),
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
	started_at: true,
	ended_at: true,
});

export const ParamDeclView = z.object({
	name: z.string(),
	type: ParamType,
	default: z.unknown().optional(),
	required: z.boolean().optional(),
	secret: z.boolean().optional(),
});

/** 运行事件流上的 `progress` 事件：一个任务的最新进度。 */
export const ProgressEvent = z.object({
	run_id: z.string(),
	chain_instance_id: z.string(),
	node_id: z.string(),
	task_id: z.string(),
	progress: TaskProgressView,
});

/** 不能触发的一个原因。 */
export const PreflightProblem = z.object({
	code: z.string(),
	message: z.string(),
	node_id: z.string().optional(),
});

export const runsApi = {
	/**
	 * 触发前预检：最新版本号、入口参数声明、不能触发的原因（空表示可以触发），
	 * 以及触发表单的检查清单要列出的锁定包版本与引用的 Agent（不在线不阻止触发，任务会排队）。
	 */
	preflight: endpoint({
		method: "GET",
		path: "/orchestrations/:id/preflight",
		key: ["runs", "preflight"],
		params: IdParams,
		response: z.object({
			/** 0 表示还没有版本。 */
			version: z.number().int(),
			params: z.array(ParamDeclView),
			problems: z.array(PreflightProblem),
			/** 最新版本锁定的节点包版本（包名 → 版本）；没有版本时为空。 */
			packages: z.record(z.string(), z.string()),
			/** 最新版本引用的 Agent 与在线状态，默认 Agent 在前；没有版本时为空。 */
			agents: z.array(ReferencedAgent),
		}),
	}),
	/** 一个场景的运行，按开始时间从新到旧（最多 200 条）。 */
	listForOrchestration: endpoint({
		method: "GET",
		path: "/orchestrations/:id/runs",
		key: ["runs", "by-orchestration"],
		params: IdParams,
		response: z.object({ runs: z.array(RunSummary) }),
	}),
	/**
	 * 触发场景的最新版本（201）。预检不通过时 400 `invalid_orchestration`（details 是原因列表），
	 * 参数不对时 400 `invalid_params`。
	 */
	trigger: endpoint({
		method: "POST",
		path: "/orchestrations/:id/runs",
		key: ["runs", "trigger"],
		params: IdParams,
		/** 入口参数；没有请求体等于 `{ params: {} }`。 */
		body: z
			.strictObject({ params: z.record(z.string(), z.unknown()).default({}) })
			.default({ params: {} }),
		response: RunView,
	}),
	/** 运行视图；实时更新见 {@link runsApi.events}。 */
	get: endpoint({
		method: "GET",
		path: "/runs/:id",
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
		params: IdParams,
		events: { run: RunView, progress: ProgressEvent, metrics: MetricIncrement },
	}),
};

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export const LOG_SOURCES = ["stdout", "stderr", "sdk", "system"] as const;
export const MAX_LOG_PAGE_LINES = 1000;

/** 一行日志（日志文件是 JSONL，每行就是这个对象）。 */
export const LogLineView = z.object({
	/** 任务内从 1 开始递增的序号，用来去重。 */
	seq: z.number().int(),
	time: Timestamp,
	/** system：控制面写入的截断标记。 */
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

export const LogPageQuery = z
	.object({
		/** 往前翻页：读这个字节偏移之前的行（默认文件末尾）。 */
		before: blankAsMissing(ByteOffset),
		/** 往后翻页：读这个字节偏移之后的行。不能与 before 同时给。 */
		after: blankAsMissing(ByteOffset),
		limit: z.coerce.number().int().min(1).max(MAX_LOG_PAGE_LINES).default(200),
		/** 只要这些级别，逗号分隔。 */
		level: blankAsMissing(csv(LOG_LEVELS)),
		/** 只要这些来源，逗号分隔。 */
		source: blankAsMissing(csv(LOG_SOURCES)),
	})
	.refine((q) => q.before === undefined || q.after === undefined, {
		message: "before 与 after 不能同时给",
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
		key: ["logs", "page"],
		params: IdParams,
		query: LogPageQuery,
		response: LogPage,
	}),
	/**
	 * 日志的实时推送（SSE）：事件 `logs` 是新写入的一批行，`after_seq` 是已经读到的最大序号
	 * （从分页的 last_seq 接上，浏览器重连时按 Last-Event-ID 续传）。
	 */
	events: stream({
		path: "/tasks/:id/logs/events",
		params: IdParams,
		query: z.object({ after_seq: z.string().optional() }),
		events: { logs: LogChunk },
	}),
	/** 下载原始日志（JSONL，只含请求时已写入的内容）；运行已过保留期时 410 `expired`。 */
	download: download({
		path: "/tasks/:id/logs/download",
		params: IdParams,
		contentType: "application/x-ndjson",
	}),
};

export const ArtifactView = z.object({
	/** 产物目录内的相对路径（`/` 分隔）。 */
	name: z.string(),
	size: z.number().int(),
	sha256: z.string(),
	created_at: Timestamp,
	/** 对 Agent 可见的完整下载地址（节点输出里的产物引用）；浏览器用 `/api/tasks/:id/artifacts/<name>`。 */
	url: z.string(),
});

const ArtifactParams = z.object({ id: z.string(), "*": z.string() });

export const artifactsApi = {
	/** 一个任务的产物；运行已超过保留期被清理时 expired 为 true、列表为空。 */
	list: endpoint({
		method: "GET",
		path: "/tasks/:id/artifacts",
		key: ["artifacts", "list"],
		params: IdParams,
		response: z.object({
			task_id: z.string(),
			artifacts: z.array(ArtifactView),
			expired: z.boolean(),
		}),
	}),
	/**
	 * Agent 上传一个产物（201）：请求体是文件内容（原始字节，不在契约里）；`*` 是产物目录内的相对路径，
	 * 每个路径段单独百分号编码。配置了注册令牌时需要 `Authorization: Bearer <token>`，否则 401 `unauthorized`；
	 * 超过单个任务的产物上限时 413。
	 */
	upload: endpoint({
		method: "PUT",
		path: "/tasks/:id/artifacts/*",
		key: ["artifacts", "upload"],
		params: ArtifactParams,
		response: ArtifactView,
	}),
	/** 下载一个产物（attachment）；运行已过保留期被清理时 410 `expired`。 */
	download: download({
		path: "/tasks/:id/artifacts/*",
		params: ArtifactParams,
		contentType: "application/octet-stream",
	}),
};

export type RunStatus = z.infer<typeof RunStatus>;
export type TaskStatus = z.infer<typeof TaskStatus>;
export type NodeStatus = z.infer<typeof NodeStatus>;
export type ErrorView = z.infer<typeof ErrorView>;
export type TaskProgressView = z.infer<typeof TaskProgressView>;
export type AttemptView = z.infer<typeof AttemptView>;
export type NodeRunView = z.infer<typeof NodeRunView>;
export type ChainRunView = z.infer<typeof ChainRunView>;
export type RunView = z.infer<typeof RunView>;
export type RunSummary = z.infer<typeof RunSummary>;
export type ParamDeclView = z.infer<typeof ParamDeclView>;
export type PreflightProblem = z.infer<typeof PreflightProblem>;
export type LogLineView = z.infer<typeof LogLineView>;
export type LogPage = z.infer<typeof LogPage>;
export type LogChunk = z.infer<typeof LogChunk>;
export type ProgressEvent = z.infer<typeof ProgressEvent>;
export type ArtifactView = z.infer<typeof ArtifactView>;
