// Drizzle 表定义（唯一来源）。修改后运行 `pnpm --filter @sfly/server db:generate --name <描述>` 生成迁移。
// 表随各票据加入，见 docs/ARCHITECTURE.md §6.2。
import {
	type AgentUpdateState,
	ON_AGENT_STATUSES,
	type OrchestrationDocument,
	type PackageMetadata,
} from "@sfly/schema";
import { sql } from "drizzle-orm";
import {
	bigint,
	bigserial,
	boolean,
	doublePrecision,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** Agent 上报的信息（Hello）。 */
export interface AgentInfo {
	agent_version: string;
	os: string;
	arch: string;
	slots: number;
	/**
	 * 共享 venv 中已安装的节点包；由 Agent 在 Hello 中上报（#5）。
	 * 早于 #5 注册的记录没有这个字段，读取时按空列表处理。
	 */
	installed_packages?: InstalledPackage[];
	/** 最近一次 InstallStatus 上报的安装状态（#6）；每次连接（Hello）时清空。 */
	install?: InstallProgress;
	/** 以开发模式（sfly dev）加载在这个 Agent 上的节点包（#19）；Hello 和 InstallStatus 中上报。 */
	dev_packages?: DevPackageInfo[];
	/** 最近一次 Heartbeat 上报的更新状态（ADR 0014）；每次连接（Hello）时清空。 */
	update?: AgentUpdateInfo;
	/** Hello 上报的 Agent 能力及版本（ADR 0019）；旧版本 Agent 和早于 #196 注册的记录没有。 */
	capabilities?: CapabilityInfo[];
	/** Hello 上报的、供其它 Agent 连接的端口（ADR 0019）；不监听端口的旧版本 Agent 没有。 */
	peer?: PeerEndpointInfo;
	/** 控制面看到的这次连接的来源地址（ADR 0019）；早于 #196 注册的记录没有。 */
	source_address?: string;
}

/** 一项 Agent 能力（@sfly/schema 的 CapabilityView）。 */
export interface CapabilityInfo {
	name: string;
	version: number;
}

/** Agent 在 Hello 中上报的端口（proto 的 PeerEndpoint）。 */
export interface PeerEndpointInfo {
	port: number;
	/** 安装时显式配置的对外地址；没有配置时为空串。 */
	public_address: string;
	/** 没能监听的原因；正在监听时为空串。 */
	listen_error: string;
}

/** Agent 的更新状态（@sfly/schema 的 AgentUpdateView）。 */
export interface AgentUpdateInfo {
	state: AgentUpdateState;
	remaining_tasks: number;
	reason: string;
}

/** Agent 上以开发模式加载的节点包 `包名@dev`。 */
export interface DevPackageInfo {
	name: string;
	/** Agent 所在机器上的源码目录。 */
	source: string;
	/** 加载时扫描出的节点包元信息（version 为 dev）；Agent 上报的内容不是 JSON 对象时为 null。 */
	metadata: Record<string, unknown> | null;
}

export interface InstallProgress {
	package: string;
	version: string;
	state: "installing" | "installed" | "failed";
	task_id: string;
}

export interface InstalledPackage {
	name: string;
	version: string;
}

export type AgentStatus = "online" | "offline";

/** Agent：按名称唯一；第一次 Hello 时注册，之后每次连接更新信息。 */
export const agents = pgTable("agents", {
	name: text("name").primaryKey(),
	info: jsonb("info").$type<AgentInfo>().notNull(),
	status: text("status").$type<AgentStatus>().notNull(),
	registeredAt: timestamptz("registered_at").notNull(),
	lastSeenAt: timestamptz("last_seen_at").notNull(),
	/** 最近一次 Hello 或 Heartbeat 测得的时钟偏差（Agent 时间 − 控制面时间，毫秒，#172）；未知时为空。 */
	clockOffsetMs: bigint("clock_offset_ms", { mode: "number" }),
	/** 测得 clock_offset_ms 的控制面时间。 */
	clockOffsetMeasuredAt: timestamptz("clock_offset_measured_at"),
});

/**
 * 飞书机器人（ADR 0020）：按名称唯一，创建后不能改名。webhook_url 明文保存（相当于一个凭据，和 secret 参数一样），
 * 只在界面和日志里打码（src/feishu/webhook-url.ts）；接口不返回完整地址。
 */
export const feishuBots = pgTable("feishu_bots", {
	name: text("name").primaryKey(),
	webhookUrl: text("webhook_url").notNull(),
	createdAt: timestamptz("created_at").notNull(),
});

/**
 * 场景：记录当前最新版本号（0 表示还没有保存过版本）。名称和说明不属于版本内容，可以随时修改（#33）。
 * 归档（#33）：archived_at 不为空时不出现在默认列表、不能触发；不物理删除。
 */
export const orchestrations = pgTable("orchestrations", {
	id: uuid("id").primaryKey(),
	name: text("name").notNull(),
	description: text("description").notNull().default(""),
	headVersion: integer("head_version").notNull().default(0),
	createdAt: timestamptz("created_at").notNull(),
	archivedAt: timestamptz("archived_at"),
});

/** 编排版本：不可变，同一编排内编号唯一、递增。 */
export const orchestrationVersions = pgTable(
	"orchestration_versions",
	{
		id: uuid("id").primaryKey(),
		orchestrationId: uuid("orchestration_id")
			.notNull()
			.references(() => orchestrations.id),
		number: integer("number").notNull(),
		document: jsonb("document").$type<OrchestrationDocument>().notNull(),
		author: text("author").notNull(),
		createdAt: timestamptz("created_at").notNull(),
	},
	(t) => [unique("orchestration_versions_number").on(t.orchestrationId, t.number)],
);

export type RunStatus = "running" | "success" | "failed" | "cancelled";
export type ChainStatus = RunStatus;
/**
 * 任务状态（docs/SEMANTICS.md §3.1）。skipped（#11）：前面的节点失败、本节点不是 always，
 * 记一行 attempt 1 的占位（没有派发，不算一次尝试）。
 * cancelled（#12）：运行被取消；没有开始执行（started_at 为空）的行是占位，不算一次尝试。
 */
/** waiting：定时 / Sleep 节点正在等待唤醒时间（#14），或停止子流程节点在等被停止的子流程结束，不占用 Agent。 */
/** stopped：所在子流程被停止子流程节点停止（docs/SEMANTICS.md §4.1）；没有开始执行的行是占位，不算一次尝试。 */
/**
 * dispatched：已派发给 Agent，Agent 还在下载、安装节点包或启动执行器；Agent 上报 TaskStarted 后才是 running，
 * 超时和耗时都从 running 开始计算（docs/SEMANTICS.md §3.3）。
 */
export type TaskStatus =
	| "queued"
	| "dispatched"
	| "running"
	| "waiting"
	| "success"
	| "failed"
	| "skipped"
	| "cancelled"
	| "stopped";
/** 占用 Agent 槽位、由 Agent 负责的任务状态：派发阶段和执行阶段（有租约，心跳续约）。定义在 @sfly/schema。 */
export const ON_AGENT = ON_AGENT_STATUSES satisfies readonly TaskStatus[];

/** 任务的最新进度（ctx.progress）。 */
export interface TaskProgress {
	current: number;
	/** 总数；未知时为 null。 */
	total: number | null;
	message: string;
	/** 控制面时间（ISO）：这次进度发生时的控制面时间。升级之前保存的进度没有 agent_time，这一项是 Agent 时间。 */
	time: string | null;
	/** Agent 时间（ISO）：SDK 记录这次进度的时间；没有上报时为 null。升级之前保存的进度没有这个字段。 */
	agent_time?: string | null;
}

export type ErrorKind = "node_error" | "timeout" | "agent_lost" | "env_error" | "config_error";

/** 运行：绑定一个编排版本。params 是填充默认值并覆盖后的入口参数。 */
export const runs = pgTable(
	"runs",
	{
		id: uuid("id").primaryKey(),
		orchestrationId: uuid("orchestration_id")
			.notNull()
			.references(() => orchestrations.id),
		orchestrationVersionId: uuid("orchestration_version_id")
			.notNull()
			.references(() => orchestrationVersions.id),
		triggeredBy: text("triggered_by").notNull(),
		params: jsonb("params").$type<Record<string, unknown>>().notNull(),
		status: text("status").$type<RunStatus>().notNull(),
		startedAt: timestamptz("started_at").notNull(),
		endedAt: timestamptz("ended_at"),
		/** 第一次取消（#12）的时间和昵称；之后运行在所有链结束时标记为 cancelled。 */
		cancelRequestedAt: timestamptz("cancel_requested_at"),
		cancelRequestedBy: text("cancel_requested_by"),
		/** 清理期间再次取消（强制取消）的时间：always 节点也立即终止。 */
		cancelForcedAt: timestamptz("cancel_forced_at"),
		/** 日志和产物超过保留期被清理的时间（#18，src/retention/retention.ts）；未清理时为空。 */
		purgedAt: timestamptz("purged_at"),
		/** 指标超过保留期被判定过期的时间（#32，src/metrics/metric-retention.ts）；之后摘要等接口返回「已过保留期」。 */
		metricsPurgedAt: timestamptz("metrics_purged_at"),
	},
	(t) => [index("runs_orchestration").on(t.orchestrationId), index("runs_ended_at").on(t.endedAt)],
);

/** 链实例：主链（depth 0）或子流程实例；ID 由运行、父链实例、异步任务节点确定性生成。 */
export const chainInstances = pgTable(
	"chain_instances",
	{
		id: uuid("id").primaryKey(),
		runId: uuid("run_id")
			.notNull()
			.references(() => runs.id),
		/** 链起点（入口节点 / 子流程入口节点）的节点 ID。 */
		chainId: text("chain_id").notNull(),
		parentChainInstanceId: uuid("parent_chain_instance_id"),
		asyncNodeId: text("async_node_id"),
		depth: integer("depth").notNull(),
		params: jsonb("params").$type<Record<string, unknown>>().notNull(),
		status: text("status").$type<ChainStatus>().notNull(),
		startedAt: timestamptz("started_at").notNull(),
		endedAt: timestamptz("ended_at"),
		/**
		 * 停止（docs/SEMANTICS.md §4.1）：停止这个子流程实例的停止子流程节点任务（tasks.id）和停止的时间；没有被停止时为空。
		 * 停止的全部状态都在这里：之后未开始的普通节点记为 stopped、Agent 上报的取消结果记为 stopped，
		 * 停止子流程节点（waiting）在目标子流程实例和它的各级下级实例都结束后成功。控制面重启后照常推进。
		 */
		stopTaskId: uuid("stop_task_id"),
		stopRequestedAt: timestamptz("stop_requested_at"),
	},
	(t) => [index("chain_instances_run").on(t.runId)],
);

/** 任务：节点在运行中的一次尝试（内置节点也记一条，agent_name 为空）。ID 由链实例、节点、attempt 确定性生成。 */
export const tasks = pgTable(
	"tasks",
	{
		id: uuid("id").primaryKey(),
		runId: uuid("run_id")
			.notNull()
			.references(() => runs.id),
		chainInstanceId: uuid("chain_instance_id")
			.notNull()
			.references(() => chainInstances.id),
		nodeId: text("node_id").notNull(),
		attempt: integer("attempt").notNull(),
		agentName: text("agent_name"),
		status: text("status").$type<TaskStatus>().notNull(),
		/** 派发时解析过引用的输入；排队时为空。 */
		inputs: jsonb("inputs").$type<Record<string, unknown>>(),
		outputs: jsonb("outputs").$type<Record<string, unknown>>(),
		errorKind: text("error_kind").$type<ErrorKind>(),
		errorMessage: text("error_message"),
		/** 进入 queued 的时间，派发按它排序。 */
		queuedAt: timestamptz("queued_at").notNull(),
		/** 用于同一时刻排队的任务保持创建顺序。 */
		seq: bigserial("seq", { mode: "number" }).notNull(),
		startedAt: timestamptz("started_at"),
		endedAt: timestamptz("ended_at"),
		/**
		 * 任务开始时的时钟偏差（Agent 时间 − 控制面时间，毫秒，#175）和它对应的控制面时间：TaskStarted 里的
		 * 时钟读数折算出来的，不是收到消息的时刻（started_at 才是）。旧版本 Agent 或没有上报时为空。
		 */
		startClockOffsetMs: bigint("start_clock_offset_ms", { mode: "number" }),
		startClockOffsetMeasuredAt: timestamptz("start_clock_offset_measured_at"),
		/** 任务结束时的时钟偏差和它对应的控制面时间，来自 TaskResult，含义同上。 */
		endClockOffsetMs: bigint("end_clock_offset_ms", { mode: "number" }),
		endClockOffsetMeasuredAt: timestamptz("end_clock_offset_measured_at"),
		/** 最新进度（#10），只保留最后一次上报的值。 */
		progress: jsonb("progress").$type<TaskProgress>(),
		/** 日志文件（#10）：相对数据目录的路径，第一次收到日志时设置；格式见 src/logs/task-logs.ts。 */
		logPath: text("log_path"),
		/** 日志文件已写入的字节数。 */
		logBytes: bigint("log_bytes", { mode: "number" }).notNull().default(0),
		/** 已写入的最大日志序号（序号不大于它的行视为重复）。 */
		logSeq: bigint("log_seq", { mode: "number" }).notNull().default(0),
		/** 日志超过上限已被截断（#18）：写入了截断标记，之后的行都被丢弃。 */
		logTruncated: boolean("log_truncated").notNull().default(false),
		/**
		 * 定时 / Sleep 节点的唤醒时间（#14）：waiting 期间由控制面周期扫描，到期后节点成功。
		 * 定时器的全部状态都在这一行里（status + wake_at），控制面重启后照常扫描。
		 */
		wakeAt: timestamptz("wake_at"),
		/**
		 * 运行中任务的租约到期时间（#15）：派发时设置，Agent 心跳续约；过期后任务以 agent_lost 失败。
		 */
		leaseExpiresAt: timestamptz("lease_expires_at"),
		/** 排队中任务的排队超时时间（#15）：进入 queued 时按节点的 queue_timeout 设置；过期后以 env_error 失败。 */
		queueExpiresAt: timestamptz("queue_expires_at"),
		/** 已写入的指标点数（#29，所有指标合计）；达到上限后不再写入。 */
		metricPoints: bigint("metric_points", { mode: "number" }).notNull().default(0),
		/** 指标超过单任务上限已被截断（#29）：之后上报的点都被丢弃。 */
		metricTruncated: boolean("metric_truncated").notNull().default(false),
		/**
		 * 任务的序列数超过上限（#78，每个任务 1000 个）：之后新出现的序列的点都被丢弃（计入 metric_dropped），
		 * 已有序列照常写入。
		 */
		metricSeriesCapped: boolean("metric_series_capped").notNull().default(false),
		/** Agent 断线排队超过上限而丢弃的指标点数（#29，Agent 在 MetricBatch 中上报）。 */
		metricDropped: bigint("metric_dropped", { mode: "number" }).notNull().default(0),
	},
	(t) => [
		index("tasks_waiting").on(t.wakeAt).where(sql`${t.status} = 'waiting'`),
		index("tasks_lease").on(t.leaseExpiresAt).where(sql`${t.status} = 'running'`),
		index("tasks_queue_timeout").on(t.queueExpiresAt).where(sql`${t.status} = 'queued'`),
		unique("tasks_attempt").on(t.chainInstanceId, t.nodeId, t.attempt),
		index("tasks_agent_status").on(t.agentName, t.status),
		index("tasks_chain_instance").on(t.chainInstanceId),
	],
);

/**
 * 产物（#18）：任务结束后 Agent 通过 HTTP 上传的文件。同一任务内按名称（产物目录内的相对路径）唯一，
 * 重复上传覆盖。文件在 `<数据目录>/artifacts/<run_id>/<task_id>/<name>`（path 相对数据目录）。
 */
export const artifacts = pgTable(
	"artifacts",
	{
		id: uuid("id").primaryKey(),
		taskId: uuid("task_id")
			.notNull()
			.references(() => tasks.id),
		runId: uuid("run_id")
			.notNull()
			.references(() => runs.id),
		name: text("name").notNull(),
		path: text("path").notNull(),
		size: bigint("size", { mode: "number" }).notNull(),
		sha256: text("sha256").notNull(),
		/** 上传时间（控制面时间）。 */
		createdAt: timestamptz("created_at").notNull(),
		/** 文件在 Agent 上的修改时间（Agent 时间，#171）；旧版本 Agent 不上报时为空。 */
		agentModifiedAt: timestamptz("agent_modified_at"),
	},
	(t) => [unique("artifacts_task_name").on(t.taskId, t.name), index("artifacts_run").on(t.runId)],
);

/** 已发布的节点包版本；`包名@版本` 唯一，发布后不可变。 */
export const nodePackages = pgTable(
	"node_packages",
	{
		name: text("name").notNull(),
		version: text("version").notNull(),
		metadata: jsonb("metadata").$type<PackageMetadata>().notNull(),
		/** 相对控制面数据目录的路径。 */
		filePath: text("file_path").notNull(),
		sha256: text("sha256").notNull(),
		size: bigint("size", { mode: "number" }).notNull(),
		publishedAt: timestamptz("published_at").notNull(),
	},
	(t) => [primaryKey({ columns: [t.name, t.version] })],
);

/**
 * 指标摘要（#29）：每个任务（一次尝试）每个序列（指标名 + 标签，#78）一行，写段时一起更新；主指标和列表页直接读它，不扫描原始段。
 * 原始数据在按天分区的分段表 `metric_segments`（drizzle 不支持声明式分区，迁移里手写，见 src/metrics/task-metrics.ts）。
 */
export const metricSeries = pgTable(
	"metric_series",
	{
		taskId: uuid("task_id")
			.notNull()
			.references(() => tasks.id),
		runId: uuid("run_id")
			.notNull()
			.references(() => runs.id),
		metric: text("metric").notNull(),
		/** 序列的标签（#78）：与指标名一起区分序列；不带标签的序列为 `{}`。jsonb 的规范形式保证内容相同的标签相等。 */
		labels: jsonb("labels").$type<Record<string, string>>().notNull().default({}),
		points: integer("points").notNull(),
		min: doublePrecision("min").notNull(),
		max: doublePrecision("max").notNull(),
		/** 值的总和（平均值 = sum / points）。 */
		sum: doublePrecision("sum").notNull(),
		last: doublePrecision("last").notNull(),
		/** 首尾两个点的控制面时间（ADR 0018）。升级之前写入的行（Agent 时间两列为空）这两列是 Agent 时间。 */
		firstAt: timestamptz("first_at").notNull(),
		lastAt: timestamptz("last_at").notNull(),
		/** 首尾两个点的 Agent 时间（#174）；升级之前写入的行为空。 */
		firstAgentAt: timestamptz("first_agent_at"),
		lastAgentAt: timestamptz("last_agent_at"),
	},
	(t) => [
		primaryKey({ columns: [t.taskId, t.metric, t.labels] }),
		index("metric_series_run").on(t.runId),
	],
);
