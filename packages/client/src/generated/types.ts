// 由 HTTP 契约（packages/schema/src/http）生成，不要手改：pnpm gen。

/** 其它 Agent 连接这台 Agent、调用它的能力用的地址（ADR 0019），按最近一次连接上报的。 */
export interface AgentEndpointView {
	/**
	 * 对外地址（IP 地址或主机名）：安装时显式配置的，没有配置时是控制面看到的连接来源地址。
	 * 早于这个字段注册、之后没有再连接过的 Agent 为空串。
	 */
	address: string;
	/** configured：安装时显式配置的；connection：控制面看到的连接来源地址。 */
	address_source: "configured" | "connection";
	/** 监听的端口；不监听端口的旧版本 Agent 为 null。 */
	port: number | null;
	/**
	 * 这台 Agent 的能力不能被其它 Agent 调用的原因（例如端口被占用、旧版本 Agent 不监听端口）；可以调用时为 null。
	 * 不影响它执行任务。
	 */
	unavailable_reason: string | null;
}

/**
 * Agent 的更新状态（ADR 0014，Agent 在 Heartbeat 中上报）：none 不需要更新；downloading 下载、校验新版本；
 * waiting_for_tasks 等手上的任务结束（remaining_tasks）；replacing 替换并重新执行；failed 更新失败（reason）；
 * manual_upgrade_required 不能自更新、需要手动升级（reason）。
 */
export type AgentUpdateState = "none" | "downloading" | "waiting_for_tasks" | "replacing" | "failed" | "manual_upgrade_required";

export interface AgentUpdateView {
	state: AgentUpdateState;
	/** waiting_for_tasks 时还要等的任务数，其余状态为 0。 */
	remaining_tasks: number;
	/** failed / manual_upgrade_required 的原因，其余状态为空串。 */
	reason: string;
}

export interface AgentView {
	name: string;
	status: "online" | "offline";
	info: {
		agent_version: string;
		os: string;
		arch: string;
		slots: number;
		installed_packages: InstalledPackageView[];
	};
	/** 在线时是本次连接（或最近一次上报）的时间，离线时是最后在线的时间。 */
	last_seen_at: Timestamp;
	/**
	 * 在线 Agent 正在准备环境（收到 Welcome 之后、第一次心跳之前，不接任务）时，这次连接发出 Welcome 的控制面时间（ADR 0018）；
	 * 已准备好或离线时为 null。只记在控制面内存里，跟着连接走。
	 */
	preparing_since: Timestamp | null;
	/** Agent 共享 venv 中已安装的节点包。 */
	installed_packages: InstalledPackageView[];
	/** 本次连接还没有安装过节点包时为 null。 */
	install: InstallProgressView | null;
	dev_packages: DevPackageView[];
	/** 按派发顺序排列；长度即占用的槽位数。 */
	running_tasks: RunningTaskView[];
	/**
	 * Agent 版本与控制面版本（列表响应的 control_plane_version）不一致：控制面不给它派新任务（ADR 0014），
	 * 它手上的任务照常跑完。按最近一次连接上报的版本判断。
	 */
	version_mismatch: boolean;
	/** 最近一次 Heartbeat 上报的更新状态；本次连接还没上报过（或旧版本 Agent 不上报）时为 none。 */
	update: AgentUpdateView;
	/**
	 * 最近一次 Hello 或 Heartbeat 测得的时钟偏差（ADR 0018）；离线时是断开前最后一次测得的。
	 * 未知时为 null：本次（或最近一次）连接的 Agent 是不上报时间的旧版本。
	 */
	clock_offset: ClockOffsetView | null;
	/** 有多少个场景引用这个 Agent（最新版本里的默认 Agent 或节点另选的 Agent）。 */
	referencing_orchestrations: number;
	/** 支持的 Agent 能力及版本，按上报的顺序；不上报能力的旧版本 Agent 为空。 */
	capabilities: CapabilityView[];
	endpoint: AgentEndpointView;
}

export interface ArtifactView {
	/** 产物目录内的相对路径（`/` 分隔）。 */
	name: string;
	size: number;
	sha256: string;
	/** 上传时间（控制面时间）。 */
	created_at: Timestamp;
	/** 文件在 Agent 上的修改时间（Agent 时间）；Agent 没有上报时为 null（未记录）。 */
	agent_modified_at: Timestamp | null;
	/** 对 Agent 可见的完整下载地址（节点输出里的产物引用）；浏览器用 `/api/tasks/:id/artifacts/<name>`。 */
	url: string;
}

export interface AsyncTaskNode {
	id: string;
	/** 布局属于版本内容。 */
	position?: {
		x: number;
		y: number;
	};
	kind: "async";
	/** 子流程参数映射：子流程入口参数名 → 值。 */
	params: Record<string, unknown>;
}

export interface AsyncTaskNodeInput {
	id: string;
	/** 布局属于版本内容。 */
	position?: {
		x: number;
		y: number;
	};
	kind: "async";
	/** 子流程参数映射：子流程入口参数名 → 值。 */
	params?: Record<string, unknown>;
}

export interface AttemptView {
	task_id: string;
	attempt: number;
	status: TaskStatus;
	agent: string | null;
	/** 已解析的输入；派发前为 null。 */
	inputs: Record<string, unknown> | null;
	outputs: Record<string, unknown> | null;
	error: ErrorView | null;
	queued_at: Timestamp;
	/** 执行器启动的时间（定时 / Sleep 节点是开始等待的时间）；排队、派发阶段为 null。 */
	started_at: Timestamp | null;
	ended_at: Timestamp | null;
	/**
	 * 任务开始、结束时的时钟偏差（ADR 0018）：Agent 在执行器启动、得到结果那一刻的 Agent 时间减去当时的控制面时间；
	 * measured_at 加 offset_ms 就是那一刻的 Agent 时间。started_at / ended_at 仍是控制面收到消息的时刻。
	 * 旧版本 Agent、升级之前的任务、不在 Agent 上执行的节点、不是由 Agent 上报而结束的任务为 null。
	 */
	start_clock_offset: ClockOffsetView | null;
	end_clock_offset: ClockOffsetView | null;
	/** 定时 / Sleep 节点的唤醒时间；其他节点为 null。 */
	wake_at: Timestamp | null;
	progress: TaskProgressView | null;
}

/** 一项 Agent 能力（ADR 0019）：Agent 自身提供、节点在执行中通过 SDK 调用的一组操作。 */
export interface CapabilityView {
	/** 能力名，例如 files。 */
	name: string;
	/** 能力的版本，从 1 开始；新增操作或改变行为时加 1。 */
	version: number;
}

/** 一个节点的一次尝试在目录里的条目。 */
export interface CatalogAttempt {
	task_id: string;
	attempt: number;
	/** 指标数据超过单任务上限，之后的点已被丢弃。 */
	truncated: boolean;
	/**
	 * 序列数超过单任务上限（`MAX_SERIES` 个，见 ../series.ts；不带标签的指标各算 1 个）：之后新出现的序列的点已被丢弃
	 * （计入 dropped_points），已有序列照常写入。
	 */
	series_capped: boolean;
	/** 被丢弃的点数：Agent 断线期间排队超过上限、标签与声明的标签键不一致、序列超限。 */
	dropped_points: number;
	/** 已写库的点的摘要（每个序列一项），按指标名、标签排序；运行中的当前段约每 10 秒写一次。 */
	metrics: MetricSummary[];
}

/** 目录里的一个包节点（链实例 × 节点）。 */
export interface CatalogNode {
	chain_instance_id: string;
	node_id: string;
	package: string;
	/** 节点类型名（包内）。 */
	node: string;
	/** 锁定的节点包版本；`dev` 时声明取任务所在 Agent 当前加载的源码。 */
	version: string;
	/** 节点类型声明的指标；找不到节点类型（例如 dev 包已卸载）时为空。 */
	metrics: MetricDeclaration[];
	/** 声明的图表在前，之后是为没被任何图表引用的指标生成的默认图表。 */
	charts: ChartView[];
	primary_metric: MetricName | null;
	/** 各次尝试，按 attempt 升序；最后一个是最新一次。 */
	attempts: CatalogAttempt[];
}

/** 链实例：主链（depth 0）或由异步任务节点派发的子流程实例。 */
export interface ChainRunView {
	id: string;
	/** 链起点节点 ID（主链是入口节点，子流程是子流程入口节点）。 */
	chain_id: string;
	/** 子流程名称（没有名称的旧版本为子流程入口的节点 ID，名称为空时为空字符串）；主链为 null。 */
	name: string | null;
	parent_chain_instance_id: string | null;
	/** 派发这个子流程实例的异步任务节点；主链为 null。 */
	async_node_id: string | null;
	depth: number;
	status: RunStatus;
	params: Record<string, unknown>;
	started_at: Timestamp;
	ended_at: Timestamp | null;
	/** 这条链上的节点，按链上的顺序。 */
	nodes: NodeRunView[];
}

/**
 * 节点包查询 API 返回的图表：声明的图表（default=false）之后，是控制面为没被任何图表引用的
 * 指标生成的默认图表（default=true）。
 */
export interface ChartView {
	title: string;
	type: "line" | "area" | "bar" | "stat";
	metrics: MetricName[];
	default: boolean;
}

/**
 * 一次测得的时钟偏差（ADR 0018）：Agent 时间减去控制面时间，误差是一次单程网络延迟。
 * Agent 视图、任务和尝试视图（开始、结束时的偏差）共用这个形状。
 */
export interface ClockOffsetView {
	/** Agent 时间 − 控制面时间（毫秒）：正数表示 Agent 比控制面快，负数表示慢。 */
	offset_ms: number;
	/** 测量时刻（控制面时间）。 */
	measured_at: Timestamp;
	/** 偏差的绝对值达到 2 秒：页面只在这时提示，不到 2 秒视为一致。由控制面统一判断。 */
	exceeds_threshold: boolean;
}

export interface DashboardAgent {
	name: string;
	status: "online" | "offline";
	slots: number;
	/** 占用的槽位数（派发中与执行中的任务）。 */
	used_slots: number;
	/** 正在安装的节点包；没有在安装时为 null。 */
	installing: {
		package: string;
		version: string;
	} | null;
	last_seen_at: Timestamp;
}

export interface DashboardAgentStats {
	online: number;
	offline: number;
	/** 在线 Agent 的槽位合计与占用。 */
	slots: number;
	used_slots: number;
	/** 全部注册过的 Agent，按名称排序。 */
	list: DashboardAgent[];
}

/** 运行中的链实例：节点按链上的顺序，状态与运行视图一致（pending、queued、running、success…）。 */
export interface DashboardChain {
	id: string;
	chain_id: string;
	/** 子流程实例（不是主链）。 */
	subflow: boolean;
	status: string;
	nodes: {
		node_id: string;
		status: string;
	}[];
}

/** 最近失败的一条：一个失败的链实例（主链失败即运行失败；子流程失败单独一条）。 */
export interface DashboardFailure {
	run_id: string;
	orchestration_id: string;
	orchestration_name: string;
	/** 所在运行的当前状态（子流程失败时主链可能还在运行）。 */
	run_status: string;
	chain_instance_id: string;
	chain_id: string;
	subflow: boolean;
	/** 最先失败的节点（最后一次尝试失败）；没有失败节点时（例如校验失败）为 null。 */
	node_id: string | null;
	error: {
		kind: string;
		message: string;
	} | null;
	/** 链实例结束的时间。 */
	failed_at: Timestamp;
}

/** 趋势里的一小时：[start, start + 1h) 内结束的运行数（恰好在 generated_at 结束的归入最后一个桶）。 */
export interface DashboardHour {
	start: Timestamp;
	success: number;
	failed: number;
	cancelled: number;
}

export interface DashboardPackage {
	name: string;
	version: string;
	published_at: Timestamp;
	/** 有多少个场景的最新版本锁定了这个版本。 */
	locked_orchestrations: number;
}

export interface DashboardRunStats {
	/** 正在运行的运行数（含取消中的）。 */
	running: number;
	/** 正在运行的链实例数（主链与子流程）。 */
	running_chains: number;
	/** 已派发给 Agent、还没结束的任务数（派发中与执行中）。 */
	running_tasks: number;
	/** 排队等待 Agent 的任务数。 */
	queued_tasks: number;
	success: number;
	failed: number;
	cancelled: number;
	/** 窗口内失败的子流程实例数（不论所在运行是否已结束）。 */
	failed_subflows: number;
	/** 成功率 = 成功 / 结束的运行数（0–1）；窗口内没有结束的运行时为 null。 */
	success_rate: number | null;
	/** 前一个 24 小时的成功率，用于对比；没有结束的运行时为 null。 */
	previous_success_rate: number | null;
}

export interface DashboardRunningRun {
	id: string;
	orchestration_id: string;
	orchestration_name: string;
	orchestration_version: number;
	triggered_by: string;
	started_at: Timestamp;
	/** 已请求取消、正在清理（运行状态仍是 running）。 */
	cancelling: boolean;
	chains: DashboardChain[];
}

export interface DashboardView {
	/** 统计的时刻（控制面时钟），窗口的终点。 */
	generated_at: Timestamp;
	runs: DashboardRunStats;
	/** 24 个小时桶，从旧到新；最后一个桶以 generated_at 为终点。 */
	hourly: DashboardHour[];
	/** 正在运行的运行，按开始时间从新到旧。 */
	running_runs: DashboardRunningRun[];
	/** 窗口内失败的链实例，按失败时间从新到旧（最多 10 条）。 */
	recent_failures: DashboardFailure[];
	agents: DashboardAgentStats;
	/** 最近发布的节点包版本，从新到旧（最多 5 个）。 */
	recent_packages: DashboardPackage[];
}

/** Agent 上以开发模式（sfly dev）加载的节点包；metadata 是加载时扫描出的元信息，未经发布校验。 */
export interface DevPackageView {
	name: string;
	source: string;
	metadata: Record<string, unknown> | null;
}

/** 保存时返回的静态检查警告（@sfly/orchestration 的 documentWarnings）；只提示，不阻止保存。 */
export interface DocumentWarningView {
	code: string;
	message: string;
	node_id?: string;
	input?: string;
}

export interface Edge {
	from: string;
	to: string;
	/** chain：链上的顺序连线；dispatch：异步任务节点 → 子流程入口节点的调度连线。 */
	kind: "chain" | "dispatch";
}

export interface EntryNode {
	id: string;
	/** 布局属于版本内容。 */
	position?: {
		x: number;
		y: number;
	};
	kind: "entry";
	params: ParamDeclaration[];
}

export interface EntryNodeInput {
	id: string;
	/** 布局属于版本内容。 */
	position?: {
		x: number;
		y: number;
	};
	kind: "entry";
	params?: ParamDeclarationInput[];
}

/** 错误：kind 是错误类型（node_error、timeout、agent_lost、env_error、config_error）；message 可能带堆栈（空行之后）。 */
export interface ErrorView {
	kind: string;
	message: string;
}

/** 机器人名称：去掉首尾空白后 1 到 `FEISHU_BOT_NAME_MAX` 个字符。 */
export type FeishuBotName = string;

/**
 * 一处引用飞书机器人的地方。`kind` 区分引用的种类：飞书通知节点（`feishu_notify_node`）、
 * 「飞书机器人」类型的输入的常量值（`feishu_bot_input`，指出节点和输入名）、
 * 场景设置里的运行通知（`run_notification`，场景自己的设置，不在某个节点上）。
 */
export type FeishuBotReference = {
	kind: "feishu_notify_node";
	node_id: string;
} | {
	kind: "feishu_bot_input";
	node_id: string;
	input: string;
} | {
	kind: "run_notification";
};

/** 引用了某个飞书机器人的场景，和场景里引用它的地方。 */
export interface FeishuBotScenario {
	orchestration_id: string;
	name: string;
	references: FeishuBotReference[];
}

export interface FeishuBotView {
	name: string;
	/** 打码后的 Webhook 地址：只露出开头和结尾。完整地址不通过任何接口返回。 */
	webhook_url: string;
	created_at: Timestamp;
	/** 最近一次投递；还没有投递过时为 null。 */
	last_delivery: FeishuLastDelivery | null;
	/** 积压：还在排队、没有结果的消息条数（包括等着重试的）。 */
	backlog: number;
}

/** Markdown 卡片的标题颜色（飞书卡片 header 的颜色模板）。 */
export type FeishuCardColor = "blue" | "green" | "orange" | "red" | "grey";

/**
 * 一个机器人最近一次投递（ADR 0020）：控制面每向飞书发一次请求记一次（重试也算，丢弃不算），所以一条消息正在重试时，
 * 这里已经是失败。
 */
export interface FeishuLastDelivery {
	/** 这次请求得到结果的时间（控制面时间）。 */
	at: Timestamp;
	/** 送达了吗。 */
	ok: boolean;
	/** 没送达时的中文原因和下一步（Webhook 地址已打码）；送达时为 null。 */
	message: string | null;
}

/** 飞书通知节点的消息格式：文本、Markdown 卡片、原始消息（docs/SEMANTICS.md §4.2）。 */
export type FeishuMessageFormat = "text" | "card" | "raw";

export interface FeishuNotifyNode {
	id: string;
	/** 布局属于版本内容。 */
	position?: {
		x: number;
		y: number;
	};
	kind: "feishu_notify";
	always: boolean;
	/**
	 * 飞书机器人的名称：常量，或整值引用入口参数（docs/SEMANTICS.md §1.3）。
	 * 可选：画布新建的节点还没有选择；没有选择时保存只警告、触发时拒绝。
	 */
	bot?: string;
	/**
	 * 消息格式，决定下面哪一组字段生效。切换格式时其他格式里填过的内容留在文档里，
	 * 但不参与引用检查和解析，切回去还在。
	 */
	format: FeishuMessageFormat;
	/** 文本格式：消息文本，支持内嵌引用。 */
	text: string;
	/** 文本格式：在正文末尾追加 `<at user_id="all">所有人</at>`。 */
	at_all: boolean;
	/** Markdown 卡片：标题，支持内嵌引用。 */
	title: string;
	/** Markdown 卡片：标题颜色。 */
	color: FeishuCardColor;
	/** Markdown 卡片：Markdown 正文，支持内嵌引用。 */
	markdown: string;
	/**
	 * 原始消息：完整的飞书请求体（JSON 对象），字符串字段里的引用逐个字段解析；也可以整值引用入口参数。
	 * 可选：还没有填写时消息不发送，节点日志里写一条 warning。
	 */
	message?: unknown;
}

export interface FeishuNotifyNodeInput {
	id: string;
	/** 布局属于版本内容。 */
	position?: {
		x: number;
		y: number;
	};
	kind: "feishu_notify";
	always?: boolean;
	/**
	 * 飞书机器人的名称：常量，或整值引用入口参数（docs/SEMANTICS.md §1.3）。
	 * 可选：画布新建的节点还没有选择；没有选择时保存只警告、触发时拒绝。
	 */
	bot?: string;
	/**
	 * 消息格式，决定下面哪一组字段生效。切换格式时其他格式里填过的内容留在文档里，
	 * 但不参与引用检查和解析，切回去还在。
	 */
	format?: FeishuMessageFormat;
	/** 文本格式：消息文本，支持内嵌引用。 */
	text?: string;
	/** 文本格式：在正文末尾追加 `<at user_id="all">所有人</at>`。 */
	at_all?: boolean;
	/** Markdown 卡片：标题，支持内嵌引用。 */
	title?: string;
	/** Markdown 卡片：标题颜色。 */
	color?: FeishuCardColor;
	/** Markdown 卡片：Markdown 正文，支持内嵌引用。 */
	markdown?: string;
	/**
	 * 原始消息：完整的飞书请求体（JSON 对象），字符串字段里的引用逐个字段解析；也可以整值引用入口参数。
	 * 可选：还没有填写时消息不发送，节点日志里写一条 warning。
	 */
	message?: unknown;
}

/** 「发送测试消息」的结果；失败也是 200，结果在 `ok` 里。 */
export interface FeishuTestResult {
	ok: boolean;
	/** 一句话说明结果：成功是「测试消息已送达」，失败是中文原因（Webhook 地址已打码）。 */
	message: string;
	/** 失败时的下一步（中文）；成功时为 null。 */
	next_step: string | null;
	/** 飞书返回的错误码；成功，或者没有收到飞书的响应（网络错误、超时）时为 null。 */
	feishu_code: number | null;
	/** 收到响应时的 HTTP 状态码；网络错误和超时为 null。 */
	http_status: number | null;
}

/** Webhook 地址：必须是 http 或 https 地址，不含空白字符。 */
export type FeishuWebhookUrl = string;

/** 最近一次节点包安装状态（Agent 上报 InstallStatus）。 */
export interface InstallProgressView {
	package: string;
	version: string;
	state: "installing" | "installed" | "failed";
	task_id: string;
}

/** Agent 管理相关接口的契约（约定见 ./contract.ts）。 */
export interface InstalledPackageView {
	name: string;
	version: string;
}

/** 节点输入或输出的 JSON Schema（type=object，properties 的键即参数名 / 输出键）。 */
export interface IoSchema {
	type: "object";
	properties: Record<string, Record<string, unknown>>;
	required?: string[];
	/**
	 * properties 的键顺序（输入为函数参数顺序）。PostgreSQL JSONB 不保留对象键顺序，
	 * 参数表单按这里排列；没有时按 properties 的键顺序（#1 评审）。
	 */
	order?: string[];
	[key: string]: unknown;
}

export interface LastRun {
	id: string;
	status: "running" | "success" | "failed" | "cancelled";
	/** 已请求取消、还在等待任务结束与清理（status 仍是 running，界面显示「取消中」）。 */
	cancelling: boolean;
	/** 运行绑定的场景版本号。 */
	version: number;
	triggered_by: string;
	started_at: Timestamp;
	ended_at: Timestamp | null;
	/**
	 * 节点 ID → 状态（重试或子流程有多个实例时取最新的一条任务）；最新版本里还没有任务记录的节点为 pending。
	 * 运行绑定的可能是旧版本，所以也可能含最新版本里已经没有的节点。
	 */
	node_states: Record<string, "pending" | "queued" | "dispatched" | "running" | "waiting" | "success" | "failed" | "skipped" | "cancelled" | "stopped">;
}

export interface ListOrchestrationsQuery {
	/** 按名称、说明或引用的 Agent 搜索（不区分大小写的子串）。 */
	q?: string;
	/** 最近一次运行的状态。 */
	status?: "running" | "success" | "failed" | "cancelled";
	/** 引用了这个 Agent（默认 Agent 或节点另选的 Agent）。 */
	agent?: string;
	/** true：只看已归档的场景；默认只列出没有归档的。 */
	archived?: string;
}

/** 实时推送的一批行（`GET /tasks/:id/logs/events` 的 `logs` 事件）；offset 是第一行的字节偏移。 */
export interface LogChunk {
	task_id: string;
	lines: LogLineView[];
	offset: number;
}

/**
 * 一行日志，带两种时间（ADR 0018）。日志文件是 JSONL，每行就是这个对象（字段顺序也相同：页面按它算字节偏移）；
 * 升级之前写入的行只有一个 `time`，读出时它是 `agent_time`，`time` 为 null。
 */
export interface LogLineView {
	/** 任务内从 1 开始递增的序号，用来排序和去重。 */
	seq: number;
	/** 控制面时间：这一行在 Agent 上被读到时的控制面时间，时间线定位和按时间范围筛选用它；未记录时为 null。 */
	time: Timestamp | null;
	/** Agent 时间：原样保存，不做范围检查，只用于展示和对照；没有上报时为 null。 */
	agent_time: Timestamp | null;
	/** agent：Agent 自己写入的提示行（Agent 时间跳变）；system：控制面写入的截断标记。 */
	source: "stdout" | "stderr" | "sdk" | "agent" | "system";
	level: "debug" | "info" | "warn" | "error";
	/** secret 参数的值已替换成掩码。 */
	text: string;
}

/** 合并日志里一行的来源：它是哪个节点的哪一次尝试（任务）输出的。 */
export interface LogOrigin {
	task_id: string;
	chain_instance_id: string;
	/** 所在子流程的名称（与运行视图里链的 name 相同）；主链为 null。 */
	subflow: string | null;
	node_id: string;
	attempt: number;
}

export interface LogPage {
	task_id: string;
	/** offset：这一行在日志文件中的字节偏移。 */
	lines: {
		/** 任务内从 1 开始递增的序号，用来排序和去重。 */
		seq: number;
		/** 控制面时间：这一行在 Agent 上被读到时的控制面时间，时间线定位和按时间范围筛选用它；未记录时为 null。 */
		time: Timestamp | null;
		/** Agent 时间：原样保存，不做范围检查，只用于展示和对照；没有上报时为 null。 */
		agent_time: Timestamp | null;
		/** agent：Agent 自己写入的提示行（Agent 时间跳变）；system：控制面写入的截断标记。 */
		source: "stdout" | "stderr" | "sdk" | "agent" | "system";
		level: "debug" | "info" | "warn" | "error";
		/** secret 参数的值已替换成掩码。 */
		text: string;
		offset: number;
	}[];
	/** 本页扫描范围 [start, end)：往前翻页用 `before=start`，往后翻页用 `after=end`。 */
	start: number;
	end: number;
	/** 读取时的文件大小。 */
	size: number;
	/** 已写入的最大序号：实时流用 `after_seq` 从这里接上。 */
	last_seq: number;
	/** 日志超过大小上限被截断。 */
	truncated: boolean;
	/** 运行已超过保留期、日志已被清理（此时是空页）。 */
	expired: boolean;
}

export interface LogPageQuery {
	/** 往前翻页：读这个字节偏移之前的行（默认文件末尾）。 */
	before?: number;
	/** 往后翻页：读这个字节偏移之后的行。不能与 before 同时给。 */
	after?: number;
	limit?: number;
	level?: string;
	/** 只要这些来源，逗号分隔。 */
	source?: string;
}

/**
 * 一个桶：起始时间 + 落在桶里的点的最小（每秒最小值中的最小）、最大、平均、最新值。桶按控制面时间划分（ADR 0018）。
 * 升级之前存下的数据只有 Agent 时间：它的桶按 Agent 时间划分，`time` 为 null，`agent_time` 是桶的起始时间。
 */
export interface MetricBucket {
	/** 桶的起始时间（控制面时间）；没有记录时为 null。 */
	time: Timestamp | null;
	/** 桶里最后一个点（`last` 对应的点）的 Agent 时间。 */
	agent_time: Timestamp;
	/** 桶里的点数（每秒最多一个）。 */
	points: number;
	min: number;
	max: number;
	avg: number;
	last: number;
}

/**
 * 指标声明：`gauge` 瞬时值 | `counter` 累计值。
 * `labels` 是标签键（命名规则同指标名、不重复）：每个点必须给全这些键的值，每组标签值是一个序列；
 * 没有这个字段的指标不带标签。
 */
export interface MetricDeclaration {
	name: MetricName;
	unit: string;
	kind: "gauge" | "counter";
	description?: string;
	labels?: MetricName[];
}

/**
 * 运行事件流 `GET /runs/:id/events` 上的 `metrics` 事件：一个执行中任务新收到的点（Agent 每秒最多一批）。
 * 断线期间错过的点用序列查询补齐。
 */
export interface MetricIncrement {
	task_id: string;
	chain_instance_id: string;
	node_id: string;
	attempt: number;
	points: MetricPointView[];
}

/**
 * 序列的标签（#78）：键 → 值。一个任务里，一个指标在一组确定的标签值下的全部点构成一个序列；
 * 不带标签的序列为 `{}`。
 */
export type MetricLabels = Record<string, string>;

/** 指标名：标识符。 */
export type MetricName = string;

/** 一个合并后的点（每个序列每秒一个）。 */
export interface MetricPointView {
	name: MetricName;
	labels: MetricLabels;
	/** 这个点在 Agent 上发生的时刻对应的控制面时间（按秒取整），同一序列严格递增。 */
	time: Timestamp;
	/** 这个点的 Agent 时间：被测机器上的时间，可能与 `time` 相差很远，也可能倒退。 */
	agent_time: Timestamp;
	value: number;
	/** 这一秒内的最小、最大值（counter 与 value 相同）。 */
	min: number;
	max: number;
}

/**
 * 序列查询的结果：查询的每个指标的全部序列（按指标的查询顺序，同一指标按标签排序），每个序列的非空桶按时间升序。
 * 没有任何数据的指标：没声明标签键时给出一个 `labels` 为 `{}`、没有桶的序列，声明了标签键时没有序列。
 * 已过保留期时 `expired` 为 true，每个序列都没有桶；没有指定时间范围时 from、to 为 null。
 */
export interface MetricSeries {
	run_id: string;
	/** 已过保留期：这个运行的指标数据已被清理。 */
	expired: boolean;
	chain_instance_id: string;
	node_id: string;
	task_id: string;
	attempt: number;
	/** 实际的时间范围（控制面时间，按秒取整）；没有指定且没有任何数据时为 null。 */
	from: Timestamp | null;
	to: Timestamp | null;
	/** 每个桶的跨度（秒，至少 1）：桶 k 覆盖 [from + k × bucket_seconds, from + (k + 1) × bucket_seconds)。 */
	bucket_seconds: number;
	/** 指标数据超过单任务上限，之后的点已被丢弃。 */
	truncated: boolean;
	/**
	 * 序列数超过单任务上限（`MAX_SERIES` 个，见 ../series.ts；不带标签的指标各算 1 个）：之后新出现的序列的点已被丢弃
	 * （计入 dropped_points），已有序列照常写入。
	 */
	series_capped: boolean;
	series: {
		name: MetricName;
		labels: MetricLabels;
		buckets: MetricBucket[];
	}[];
}

/**
 * 序列查询的查询参数：节点（链实例 × 节点）、可选的尝试（默认最新一次）、
 * 指标名（逗号分隔，默认节点类型声明的全部指标）、时间范围（控制面时间，ISO，闭区间，按秒取整；默认数据的首尾时间）、
 * 目标点数（桶数上限）。
 */
export interface MetricSeriesQuery {
	chain_instance_id: string;
	node_id: string;
	attempt?: number;
	metrics?: string;
	from?: Timestamp;
	to?: Timestamp;
	points?: number;
}

/** 一个任务（一次尝试）一个序列的摘要。 */
export interface MetricSummary {
	name: MetricName;
	labels: MetricLabels;
	/** 已写入的点数（每秒最多一个点）。 */
	points: number;
	/** 所有点的每秒最小值中的最小值。 */
	min: number;
	/** 所有点的每秒最大值中的最大值。 */
	max: number;
	/** 所有点的值的平均。 */
	avg: number;
	/** 最新值。 */
	last: number;
	/** 第一个和最后一个点的控制面时间（ADR 0018）；升级之前存下的数据没有记录，为 null。 */
	first_time: Timestamp | null;
	last_time: Timestamp | null;
	/** 第一个和最后一个点的 Agent 时间。 */
	first_agent_time: Timestamp;
	last_agent_time: Timestamp;
}

/** 节点名：Python 标识符（节点类型引用形式为 `包名/节点名`）。 */
export type NodeName = string;

export interface NodeRunView {
	node_id: string;
	kind: "entry" | "subflow_entry" | "async" | "timer" | "sleep" | "stop_subflow" | "feishu_notify" | "package";
	/**
	 * 最近一次尝试的状态；还没有尝试时为 pending，被跳过时为 skipped，没开始就被取消时为 cancelled
	 * （这两种都没有尝试记录）。
	 */
	status: NodeStatus;
	/** 包节点派发到的 Agent；内置节点为 null。 */
	agent: string | null;
	outputs: Record<string, unknown> | null;
	error: ErrorView | null;
	attempts: AttemptView[];
}

export type NodeStatus = "queued" | "dispatched" | "running" | "waiting" | "success" | "failed" | "skipped" | "cancelled" | "stopped" | "pending";

/** 查询 API 返回的节点类型：图表含控制面为没被引用的指标生成的默认图表（default=true）。 */
export interface NodeTypeView {
	name: NodeName;
	title: string;
	/** 入口：`module:function`。 */
	entry: string;
	inputs: IoSchema;
	outputs: IoSchema;
	/** 节点运行时上报的指标；早于指标功能构建的节点包没有这个字段。 */
	metrics?: MetricDeclaration[];
	charts?: ChartView[];
	/** 主指标：一个已声明的指标名；没有时紧凑位置不显示。 */
	primary_metric?: MetricName;
}

export interface OrchestrationDocument {
	default_agent?: string;
	nodes: OrchestrationNode[];
	edges: Edge[];
	/** 锁定的节点包版本：包名 → 版本（`dev` 表示开发版本）。 */
	packages: Record<PackageName, string>;
}

export interface OrchestrationDocumentInput {
	default_agent?: string;
	nodes: OrchestrationNodeInput[];
	edges?: Edge[];
	/** 锁定的节点包版本：包名 → 版本（`dev` 表示开发版本）。 */
	packages?: Record<PackageName, string>;
}

/** 编辑起点：最新版本；还没有版本时是只含入口节点的初始文档（number 为 0，作者与时间为 null）。 */
export interface OrchestrationHeadView {
	orchestration_id: string;
	number: number;
	author: string | null;
	/** 经哪个 AI 编程助手保存；没有版本或没有经助手时为 null。 */
	author_via: string | null;
	created_at: Timestamp | null;
	document: OrchestrationDocument;
}

export type OrchestrationNode = EntryNode | SubflowEntryNode | AsyncTaskNode | TimerNode | SleepNode | StopSubflowNode | FeishuNotifyNode | PackageNode;

export type OrchestrationNodeInput = EntryNodeInput | SubflowEntryNodeInput | AsyncTaskNodeInput | TimerNodeInput | SleepNodeInput | StopSubflowNodeInput | FeishuNotifyNodeInput | PackageNodeInput;

/** 缩略图用的结构：最新版本（没有版本时是只含入口节点的初始文档）的节点与连线，不含参数与布局。 */
export interface OrchestrationStructure {
	nodes: {
		id: string;
		kind: "entry" | "subflow_entry" | "async" | "timer" | "sleep" | "stop_subflow" | "feishu_notify" | "package";
	}[];
	edges: {
		from: string;
		to: string;
		kind: "chain" | "dispatch";
	}[];
}

/** 场景列表里的一项（场景卡片与表格所需的全部数据）。 */
export interface OrchestrationSummary {
	id: string;
	name: string;
	description: string;
	/** 最新版本号；0 表示还没有保存过版本。 */
	head_version: number;
	created_at: Timestamp;
	/** 归档时间；没有归档时为 null。 */
	archived_at: Timestamp | null;
	run_notification: RunNotificationSettings;
	/** 最近一次保存版本的时间；没有版本时为新建时间。 */
	updated_at: Timestamp;
	/** 最新版本的节点数（含入口节点）。 */
	node_count: number;
	/** 最新版本的子流程数。 */
	subflow_count: number;
	structure: OrchestrationStructure;
	default_agent: string | null;
	/** 默认 Agent 在前，其余按名称排序。 */
	agents: ReferencedAgent[];
	/** 最近一次运行；从没运行过时为 null。 */
	last_run: LastRun | null;
}

/** 一个场景版本的完整内容。 */
export interface OrchestrationVersionView {
	id: string;
	orchestration_id: string;
	number: number;
	author: string;
	author_via: string | null;
	created_at: Timestamp;
	document: OrchestrationDocument;
}

export interface OrchestrationView {
	id: string;
	name: string;
	description: string;
	/** 最新版本号；0 表示还没有保存过版本。 */
	head_version: number;
	created_at: Timestamp;
	/** 归档时间；没有归档时为 null。 */
	archived_at: Timestamp | null;
	run_notification: RunNotificationSettings;
}

/** 节点包名：小写字母、数字、`-`、`_`，以字母或数字开头。 */
export type PackageName = string;

export interface PackageNode {
	id: string;
	/** 布局属于版本内容。 */
	position?: {
		x: number;
		y: number;
	};
	kind: "package";
	always: boolean;
	package: PackageName;
	node: NodeName;
	/** 未设置时使用编排的默认 Agent。 */
	agent?: string;
	inputs: Record<string, unknown>;
	/** 秒。 */
	timeout?: number;
	retries?: number;
	/** 秒。 */
	queue_timeout?: number;
}

export interface PackageNodeInput {
	id: string;
	/** 布局属于版本内容。 */
	position?: {
		x: number;
		y: number;
	};
	kind: "package";
	always?: boolean;
	package: PackageName;
	node: NodeName;
	/** 未设置时使用编排的默认 Agent。 */
	agent?: string;
	inputs?: Record<string, unknown>;
	/** 秒。 */
	timeout?: number;
	retries?: number;
	/** 秒。 */
	queue_timeout?: number;
}

export interface PackageSummary {
	name: string;
	/** 按发布时间从新到旧。 */
	versions: PackageVersionSummary[];
}

export interface PackageVersionSummary {
	version: string;
	sha256: string;
	size: number;
	published_at: Timestamp;
	nodes: {
		name: string;
		title: string;
	}[];
	/** 有多少个场景的最新版本锁定了这个版本。 */
	locked_orchestrations: number;
}

/** 一个已发布的版本（含完整元信息）。 */
export interface PackageVersionView {
	name: string;
	version: string;
	sha256: string;
	size: number;
	published_at: Timestamp;
	metadata: {
		name: PackageName;
		/**
		 * 版本号（PEP 440 风格，以数字开头）。`dev` 保留给开发模式（docs/SEMANTICS.md §7），
		 * 不能发布；版本号也用作控制面上的文件名，所以不能包含路径分隔符。
		 */
		version: string;
		/** Python 版本要求，例如 `>=3.10`。 */
		requires_python: string;
		/**
		 * 需要的 SDK 运行时版本（即 Agent 版本，ADR 0010），控制面派发前检查；
		 * 早于 #79 构建的节点包没有这个字段，不检查。
		 */
		requires_sdk?: RequiresSdk;
		/** 需要的 Agent 版本（`[tool.sfly] requires-agent`）；没有声明时不检查。 */
		requires_agent?: RequiresAgent;
		nodes: NodeTypeView[];
	};
}

export interface ParamDeclView {
	name: string;
	type: ParamType;
	default?: unknown;
	required?: boolean;
	secret?: boolean;
}

export interface ParamDeclaration {
	name: string;
	type: ParamType;
	default?: unknown;
	required: boolean;
	secret: boolean;
}

export interface ParamDeclarationInput {
	name: string;
	type: ParamType;
	default?: unknown;
	required?: boolean;
	secret?: boolean;
}

/**
 * 编排文档：一个编排版本的内容（docs/SEMANTICS.md）。
 * 最小版本：只表达结构，结构与引用规则的校验由控制面完成（保存时警告、触发时阻断）。
 */
export type ParamType = "string" | "number" | "boolean" | "json";

/** 平台自带图表的一个时间桶：桶内的最大值与按时间加权的平均值。 */
export interface PlatformBucket {
	time: Timestamp;
	max: number;
	avg: number;
}

/**
 * 平台自带图表（不新增存储，全部由任务记录推导）。
 * 时间序列覆盖运行的开始到结束（运行中到现在），按目标点数分桶。
 */
export interface PlatformMetrics {
	run_id: string;
	from: Timestamp;
	to: Timestamp;
	bucket_seconds: number;
	/** 所有节点的重试次数之和。 */
	retries: number;
	/** 开始过的节点（链实例 × 节点），按任务创建顺序。时长单位毫秒，运行中的尝试算到现在。 */
	nodes: {
		chain_instance_id: string;
		node_id: string;
		kind: string;
		attempts: number;
		/** 尝试次数减 1。 */
		retries: number;
		/** 各次尝试从进入排队到结束的时长之和（含排队与等待）。 */
		duration_ms: number;
		/** 包节点：各次尝试从进入排队到开始执行（含派发、安装）的时长之和。 */
		queue_ms: number;
		/** 定时 / Sleep 节点：等待的时长之和。 */
		wait_ms: number;
	}[];
	/** 本运行同时执行中的任务数（包节点从开始执行到结束）。 */
	concurrency: PlatformBucket[];
	/** 本运行用到的每个 Agent 的槽位占用：这个 Agent 上同时执行中的任务数（含其他运行的任务）。 */
	agents: {
		name: string;
		/** Agent 的槽位数；没有注册过时为 null。 */
		slots: number | null;
		occupancy: PlatformBucket[];
	}[];
}

/** 平台自带图表的查询参数。 */
export interface PlatformMetricsQuery {
	points?: number;
}

/** 运行前检查里引用的 Agent：在线的 Agent 正在准备环境时，带上开始准备的控制面时间。 */
export interface PreflightAgent {
	name: string;
	/** 场景的默认 Agent。 */
	default: boolean;
	status: "online" | "offline" | "unknown";
	/** 这次连接发出 Welcome 的控制面时间；已准备好、不在线或没有注册过时为 null（任务派发要等 Agent 准备好）。 */
	preparing_since: Timestamp | null;
}

/** 不能触发的一个原因。 */
export interface PreflightProblem {
	code: string;
	message: string;
	node_id?: string;
}

/**
 * 修改预设的请求体：只写要改的项，至少一项。没有 `params` 就不改预设参数（只改名称或说明，失效的预设也可以改名）；
 * 给了 `params` 时它是预设参数的完整清单，和新建时按同样的规则检查。
 */
export interface PresetChanges {
	name?: PresetName;
	description?: PresetDescription;
	params?: PresetParamInput[];
}

/** 预设说明：不超过 `PRESET_DESCRIPTION_MAX` 个字符。 */
export type PresetDescription = string;

/** 预设名称：去掉首尾空白后 1 到 `PRESET_NAME_MAX` 个字符，场景内唯一（区分大小写）。 */
export type PresetName = string;

/** 新建预设时的一个预设参数：参数名和固定的值。 */
export interface PresetParamInput {
	name: string;
	value: unknown;
}

/** 预设里的一个预设参数。 */
export interface PresetParamView {
	name: string;
	/** 最新版本里这个参数是不是 secret。 */
	secret: boolean;
	/** 固定的值。 */
	value: unknown;
}

export interface PresetView {
	id: string;
	name: string;
	description: string;
	/** 预设参数，按最新版本入口参数的声明顺序。 */
	params: PresetParamView[];
	/** 最后修改人的昵称。 */
	updated_by: string;
	updated_at: Timestamp;
}

/** 运行事件流上的 `progress` 事件：一个任务的最新进度。 */
export interface ProgressEvent {
	run_id: string;
	chain_instance_id: string;
	node_id: string;
	task_id: string;
	progress: TaskProgressView;
}

/** 场景引用的 Agent；unknown：还没有注册过（从没连接过控制面）。 */
export interface ReferencedAgent {
	name: string;
	/** 场景的默认 Agent。 */
	default: boolean;
	status: "online" | "offline" | "unknown";
}

/**
 * 最低 Agent 版本要求（ADR 0019）：格式与 `RequiresSdk` 相同，例如 `>=0.2.0`。用到 Agent 能力的节点包声明它，
 * 触发前和派发前对节点所在的 Agent 和它通过「Agent」类型的输入引用的 Agent 都检查。
 */
export type RequiresAgent = string;

export type RequiresSdk = string;

/** 正在执行的节点（排队、派发中、执行中、等待唤醒），按链与链上的顺序。 */
export interface RunListActiveNode {
	chain_instance_id: string;
	node_id: string;
	status: string;
	/** 最新进度；没有上报过时为 null。 */
	progress: {
		current: number;
		total: number | null;
	} | null;
}

/** 链实例的进度：节点按链上的顺序。 */
export interface RunListChain {
	id: string;
	/** 链起点节点 ID（主链是入口节点，子流程是子流程入口节点）。 */
	chain_id: string;
	/** 子流程实例（不是主链）。 */
	subflow: boolean;
	status: "running" | "success" | "failed" | "cancelled";
	nodes: {
		node_id: string;
		status: string;
	}[];
}

/** 失败的链实例：链失败或链上有节点失败（子流程失败时主链可能还在运行）。 */
export interface RunListFailure {
	chain_instance_id: string;
	chain_id: string;
	subflow: boolean;
	/** 链上第一个失败的节点；没有失败节点时（例如参数校验失败）为 null。 */
	node_id: string | null;
}

export interface RunListItem {
	id: string;
	orchestration_id: string;
	orchestration_name: string;
	orchestration_version: number;
	status: "running" | "success" | "failed" | "cancelled";
	/** 已请求取消、正在清理（运行状态仍是 running）。 */
	cancelling: boolean;
	triggered_by: string;
	/** 经哪个 AI 编程助手触发；没有时为 null。 */
	triggered_via: string | null;
	started_at: Timestamp;
	ended_at: Timestamp | null;
	/** 按深度、开始时间排序。 */
	chains: RunListChain[];
	active_nodes: RunListActiveNode[];
	failures: RunListFailure[];
}

export interface RunListQuery {
	/** 只要这个状态的运行。 */
	status?: "running" | "success" | "failed" | "cancelled";
	/** 只要这个场景的运行。 */
	orchestration_id?: string;
	/** 运行编号前缀或触发人（包含，不区分大小写）。 */
	q?: string;
	limit?: number;
}

/**
 * 按运行实时推送的一批新写入的行（`GET /runs/:id/logs/events` 的 `logs` 事件），格式与分页相同。
 * 一批里可能有多个任务的行，同一任务内按 seq；断线后补发的行（晚到的行）可能比已推送的别的任务的行更早，
 * 收到后按排序键（run-log-order.ts）插到对应位置。
 */
export interface RunLogChunk {
	lines: RunLogLine[];
}

/** 按运行合并的一行：任务日志里的一行，加上它的来源和排序要用的信息。 */
export interface RunLogLine {
	/** 任务内从 1 开始递增的序号，用来排序和去重。 */
	seq: number;
	/** 控制面时间：这一行在 Agent 上被读到时的控制面时间，时间线定位和按时间范围筛选用它；未记录时为 null。 */
	time: Timestamp | null;
	/** Agent 时间：原样保存，不做范围检查，只用于展示和对照；没有上报时为 null。 */
	agent_time: Timestamp | null;
	/** agent：Agent 自己写入的提示行（Agent 时间跳变）；system：控制面写入的截断标记。 */
	source: "stdout" | "stderr" | "sdk" | "agent" | "system";
	level: "debug" | "info" | "warn" | "error";
	/** secret 参数的值已替换成掩码。 */
	text: string;
	task_id: string;
	chain_instance_id: string;
	/** 所在子流程的名称（与运行视图里链的 name 相同）；主链为 null。 */
	subflow: string | null;
	node_id: string;
	attempt: number;
	/** 所在链路实例的层级（主链为 0）与开始时间：控制面时间相同时，链按层级、开始时间、链路实例 ID 排。 */
	chain_depth: number;
	chain_started_at: Timestamp;
	/** 节点在场景版本里这条链上的位置，从 0 开始：同一条链上按它排。 */
	node_index: number;
	/** 任务开始时间（还没开始时是排队时间）：没有控制面时间的旧行按它排。 */
	task_started_at: Timestamp;
}

/** `nodes` 查询参数：请求侧是字符串，解析成 `RunLogScope`；没有这个参数（undefined）表示全部节点。 */
export type RunLogNodesParam = string;

/**
 * 一次运行全部任务的日志合并成的一页（没选中节点时的日志视图，#220）。排序规则见 docs/ARCHITECTURE.md §6.3
 * 与 run-log-order.ts：同一个任务内按 seq，不同任务之间按控制面时间归并；时间相同时按链、节点、尝试的固定顺序；
 * 没有控制面时间的旧行用任务开始时间。比较先后要用的信息每行都带着（`RunLogTaskOrder`）。
 *
 * 游标记录每个任务读到的字节偏移：拿到这一页之后才开始的任务不在游标里，往前翻页时视为之前没有内容，往后接续时从头读。
 * 单次请求的扫描量有上限（所有任务分摊），所以一页可能不满 limit 行，筛选级别时甚至可能一行都没有；
 * 这不表示读到了开头或末尾，看 `reached_start` / `reached_end`，没到就用 `before` / `after` 接着读。
 *
 * 范围（`nodes`）和级别（`level`）在服务端执行，游标只对同一组范围和级别有效：换了范围或级别要从最新一页重新读
 * （新纳入范围的任务不在游标里，往前翻会漏掉它们）。
 */
export interface RunLogPage {
	run_id: string;
	/** 往前翻页时是游标之前（不给游标时是全部）的最后 limit 行，往后接续时是游标之后的前 limit 行，按上面的顺序。 */
	lines: RunLogLine[];
	/** 读这一页之前的行：下一次往前翻页的 before。 */
	before: string;
	/** 读这一页之后的行：往后接续的 after。 */
	after: string;
	/** before 之前已经没有任何行（这一页之前就是运行的开头）。 */
	reached_start: boolean;
	/**
	 * after 之后已经没有任何行（读取的那一刻）。往后接续时一页同样可能不满甚至为空，没到末尾就用 after 接着读；
	 * 之后写入的行用 after 再读或由实时推送送达。
	 */
	reached_end: boolean;
	/**
	 * 实时流起点：读这一页那一刻范围内每个任务已写入的位置。最新一页的这个值就是实时推送（`runEvents`）的 `after`：
	 * 之后写入的行（包括之后才开始的任务）都由实时推送送达，与这一页和往前翻到的页合起来不重复、不遗漏。
	 */
	live_after: string;
	/** 日志超过大小上限被截断的任务，按运行视图里的顺序。 */
	truncated_tasks: LogOrigin[];
	/** 运行已超过保留期、日志已被清理（此时是空页）。 */
	expired: boolean;
}

export interface RunLogPageQuery {
	/** 往前翻页：读这个游标之前的行。不给 before 和 after 时读最新的一页。 */
	before?: string;
	/** 往后接续：读这个游标之后的行。不能与 before 同时给。 */
	after?: string;
	limit?: number;
	nodes?: RunLogNodesParam;
	level?: string;
}

/**
 * 按运行读取日志的范围参数：分页、实时推送（#225）、下载（#226）共用。
 * 不给 `nodes` 是全部节点；给了空字符串是没有节点（写法与判断函数见 run-log-scope.ts）。
 */
export interface RunLogScopeQuery {
	nodes?: RunLogNodesParam;
}

/**
 * 运行的指标目录：开始过执行的包节点，按任务创建顺序。
 * 已过保留期时 `expired` 为 true，`nodes` 为空（与摘要一致）。
 */
export interface RunMetricCatalog {
	run_id: string;
	/** 已过保留期：这个运行的指标数据已被清理。 */
	expired: boolean;
	nodes: CatalogNode[];
}

/**
 * 运行的指标摘要：只列出有指标数据（或被截断、有丢弃）的任务，按任务创建顺序。
 * 已过保留期时 `expired` 为 true，`tasks` 为空。
 */
export interface RunMetricSummary {
	run_id: string;
	/** 已过保留期：这个运行的指标数据已被清理。 */
	expired: boolean;
	tasks: TaskMetricSummary[];
}

/** 更新运行通知设置的请求：只写要修改的项，其余保持不变。 */
export interface RunNotificationChanges {
	bot?: FeishuBotName | null;
	trigger?: RunNotificationTrigger;
	title?: string;
	note?: string;
}

/**
 * 场景的运行通知设置（GLOSSARY「运行通知」，ADR 0020）：和名称、说明一样是场景自己的设置，不属于场景版本，
 * 通过更新场景的接口修改，立即生效；运行结束时读取场景当前的设置。
 */
export interface RunNotificationSettings {
	/** 发给哪个飞书机器人（名称）；null 即关闭。机器人可能已被删除，运行结束时记为「未发送」。 */
	bot: string | null;
	trigger: RunNotificationTrigger;
	/** 卡片标题；空字符串时用场景名。 */
	title: string;
	/** 附加说明（Markdown，可以 @ 人），放在卡片正文的最前面；空字符串即没有。 */
	note: string;
}

/**
 * 运行通知的状态（GLOSSARY「运行通知」）：队列里的消息是排队中、已送达、失败、已丢弃（机器人被删除）；
 * 运行结束时机器人已不存在的，没有进队列，是未发送。只有场景设置里选了机器人、而且满足触发条件的运行才有。
 */
export interface RunNotificationState {
	status: "queued" | "delivered" | "failed" | "discarded" | "not_sent";
	/** 通知发给哪个飞书机器人。 */
	bot: string;
	/** 失败、已丢弃、未发送时的原因（中文，Webhook 地址已打码）；排队中和已送达为 null。 */
	reason: string | null;
}

/** 运行通知的触发条件（GLOSSARY「运行通知」）：仅失败、失败和取消、总是（成功、失败、取消都发）。 */
export type RunNotificationTrigger = "failed" | "failed_or_cancelled" | "always";

/** 运行用的运行预设，记的是触发时的情况：预设之后改名、删除都不影响。 */
export interface RunPresetView {
	/** 预设的 ID；预设可能已被删除。 */
	id: string;
	/** 触发时预设的名称。 */
	name: string;
	/** 预设参数的名单：这些参数的值来自预设。 */
	params: string[];
}

export type RunStatus = "running" | "success" | "failed" | "cancelled";

/** 运行列表里的一项。 */
export interface RunSummary {
	id: string;
	orchestration_id: string;
	orchestration_version: number;
	status: RunStatus;
	triggered_by: string;
	/** 经哪个 AI 编程助手触发（请求头 `x-sfly-client` 里的 `agent/<名称>`）；没有时为 null。只是标注，不是鉴权。 */
	triggered_via: string | null;
	started_at: Timestamp;
	ended_at: Timestamp | null;
	/** 已请求取消、还在等待任务结束与清理（status 仍是 running，界面显示「取消中」）。 */
	cancelling: boolean;
}

export interface RunView {
	id: string;
	orchestration_id: string;
	orchestration_version: number;
	status: RunStatus;
	triggered_by: string;
	/** 经哪个 AI 编程助手触发（请求头 `x-sfly-client` 里的 `agent/<名称>`）；没有时为 null。只是标注，不是鉴权。 */
	triggered_via: string | null;
	params: Record<string, unknown>;
	/** 触发时选用的运行预设；没有用预设时为 null。 */
	preset: RunPresetView | null;
	started_at: Timestamp;
	ended_at: Timestamp | null;
	/** 取消请求；没有被取消时为 null。forced_at：清理期间再次取消（强制取消）的时间。 */
	cancel: {
		requested_by: string;
		/** 经哪个 AI 编程助手取消；没有时为 null。 */
		requested_via: string | null;
		requested_at: Timestamp;
		forced_at: Timestamp | null;
	} | null;
	/**
	 * 运行通知的状态；没有发运行通知（场景没有选机器人、不满足触发条件、运行还没结束），
	 * 或者投递记录已过保留期被清理时为 null。
	 */
	run_notification: RunNotificationState | null;
	/** 按深度、开始时间排序。 */
	chains: ChainRunView[];
}

/** 派发给 Agent、还没结束的任务。 */
export interface RunningTaskView {
	task_id: string;
	run_id: string;
	orchestration_id: string;
	node_id: string;
	attempt: number;
	/** dispatched：下载、安装、启动中；running：执行器已启动。 */
	status: "dispatched" | "running";
	/** 执行器启动的时间；派发阶段为 null。 */
	started_at: Timestamp | null;
}

export interface SavedVersionView {
	id: string;
	orchestration_id: string;
	number: number;
	author: string;
	author_via: string | null;
	created_at: Timestamp;
	document: OrchestrationDocument;
	warnings: DocumentWarningView[];
}

export interface SleepNode {
	id: string;
	/** 布局属于版本内容。 */
	position?: {
		x: number;
		y: number;
	};
	kind: "sleep";
	always: boolean;
	/** 例如 `30s`、`10m`、`1h`，可以是引用。 */
	duration: string;
}

export interface SleepNodeInput {
	id: string;
	/** 布局属于版本内容。 */
	position?: {
		x: number;
		y: number;
	};
	kind: "sleep";
	always?: boolean;
	/** 例如 `30s`、`10m`、`1h`，可以是引用。 */
	duration: string;
}

export interface StopSubflowNode {
	id: string;
	/** 布局属于版本内容。 */
	position?: {
		x: number;
		y: number;
	};
	kind: "stop_subflow";
	always: boolean;
	/**
	 * 要停止的子流程：子流程入口的节点 ID（画布里按名称选择，改名不影响引用，docs/SEMANTICS.md §4.1）。
	 * 可选：画布新建的节点还没有选择；没有选择时保存只警告、触发时拒绝（§1.2）。
	 */
	subflow?: string;
}

export interface StopSubflowNodeInput {
	id: string;
	/** 布局属于版本内容。 */
	position?: {
		x: number;
		y: number;
	};
	kind: "stop_subflow";
	always?: boolean;
	/**
	 * 要停止的子流程：子流程入口的节点 ID（画布里按名称选择，改名不影响引用，docs/SEMANTICS.md §4.1）。
	 * 可选：画布新建的节点还没有选择；没有选择时保存只警告、触发时拒绝（§1.2）。
	 */
	subflow?: string;
}

export interface SubflowEntryNode {
	id: string;
	/** 布局属于版本内容。 */
	position?: {
		x: number;
		y: number;
	};
	kind: "subflow_entry";
	/**
	 * 子流程的名称，场景内唯一（停止子流程节点按名称选择子流程，docs/SEMANTICS.md §4.1）。
	 * 可选只为兼容旧版本：没有该字段时以节点 ID 作为名称；为空或重复时保存只警告、触发时拒绝（§1.2）。
	 */
	name?: string;
	params: ParamDeclaration[];
}

export interface SubflowEntryNodeInput {
	id: string;
	/** 布局属于版本内容。 */
	position?: {
		x: number;
		y: number;
	};
	kind: "subflow_entry";
	/**
	 * 子流程的名称，场景内唯一（停止子流程节点按名称选择子流程，docs/SEMANTICS.md §4.1）。
	 * 可选只为兼容旧版本：没有该字段时以节点 ID 作为名称；为空或重复时保存只警告、触发时拒绝（§1.2）。
	 */
	name?: string;
	params?: ParamDeclarationInput[];
}

/** 一个任务（一次尝试）的指标摘要。 */
export interface TaskMetricSummary {
	task_id: string;
	chain_instance_id: string;
	node_id: string;
	attempt: number;
	/** 指标数据超过单任务上限，之后的点已被丢弃。 */
	truncated: boolean;
	/**
	 * 序列数超过单任务上限（`MAX_SERIES` 个，见 ../series.ts；不带标签的指标各算 1 个）：之后新出现的序列的点已被丢弃
	 * （计入 dropped_points），已有序列照常写入。
	 */
	series_capped: boolean;
	/** 被丢弃的点数：Agent 断线期间排队超过上限、标签与声明的标签键不一致、序列超限。 */
	dropped_points: number;
	/** 按指标名排序，同一指标的序列按标签排序。 */
	metrics: MetricSummary[];
}

/** 最新进度（ctx.progress），带两种时间（ADR 0018）。 */
export interface TaskProgressView {
	current: number;
	/** 总数；未知时为 null。 */
	total: number | null;
	message: string;
	/** 控制面时间：这次进度发生时的控制面时间；升级之前保存的进度没有记录，为 null。 */
	time: Timestamp | null;
	/** Agent 时间：SDK 记录这次进度的时间，原样保存；没有上报时为 null。 */
	agent_time: Timestamp | null;
}

/**
 * 任务（一次尝试）与节点的状态（docs/SEMANTICS.md §3.1）。节点另有 pending（还没有尝试）。
 * dispatched：已派发给 Agent，还在下载、安装节点包或启动执行器；waiting：定时 / Sleep 节点在等唤醒时间，
 * 停止子流程节点在等被停止的子流程结束；stopped：所在子流程被停止子流程节点停止（§4.1，不算失败）。
 */
export type TaskStatus = "queued" | "dispatched" | "running" | "waiting" | "success" | "failed" | "skipped" | "cancelled" | "stopped";

export interface TimerNode {
	id: string;
	/** 布局属于版本内容。 */
	position?: {
		x: number;
		y: number;
	};
	kind: "timer";
	always: boolean;
	/** `HH:MM:SS` 或 ISO 8601 日期时间。 */
	at: string;
	tz: string;
}

export interface TimerNodeInput {
	id: string;
	/** 布局属于版本内容。 */
	position?: {
		x: number;
		y: number;
	};
	kind: "timer";
	always?: boolean;
	/** `HH:MM:SS` 或 ISO 8601 日期时间。 */
	at: string;
	tz?: string;
}

/** 时间：ISO 8601 字符串（控制面用 `Date#toISOString()` 输出）。 */
export type Timestamp = string;

export interface VersionSummaryView {
	number: number;
	author: string;
	/** 经哪个 AI 编程助手保存（请求头 `x-sfly-client` 里的 `agent/<名称>`）；没有时为 null。只是标注，不是鉴权。 */
	author_via: string | null;
	created_at: Timestamp;
}
