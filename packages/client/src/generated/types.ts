// 由 HTTP 契约（packages/schema/src/http）生成，不要手改：pnpm gen。

/** 实时推送的一批新写入或刚结束的明细（`events` 的 `actions` 事件）。同一个 ID 再出现时，以后到的为准。 */
export interface ActionChunk {
	actions: ActionDetailView[];
}

/** 一条明细：一个动作或一个标记。 */
export type ActionDetailView = ActionMarkDetail | ActionRecordDetail;

/** 一个标记的明细：只有一个时刻。 */
export interface ActionMarkDetail {
	/** 任务内的 ID（动作和标记共用一个序列）。 */
	id: number;
	/** 父动作的 ID；最外层为 null。父动作不一定有明细。 */
	parent: number | null;
	/** 层级：最外层是 0。 */
	depth: number;
	name: string;
	/** 说明字段（值都是文字），按写入的先后；动作的是开始时给的加上之后补充的。 */
	fields: Record<string, string>;
	/** 动作开始、标记发生的控制面时间。 */
	started_at: Timestamp;
	agent_started_at: Timestamp;
	kind: "mark";
}

/** 一种名称（动作和标记的名称在一起）的计数。 */
export interface ActionNameCount {
	name: string;
	/** 动作和标记的个数，不论有没有明细。 */
	total: number;
	/** 失败的动作的个数。 */
	failed: number;
	/** 有明细的个数；total 减去它是只计数、没有明细的个数。 */
	reported: number;
	/** 从什么时候起只计数（控制面时间、Agent 时间）；没有超出上限时为 null。失败的动作超出后仍有明细。 */
	capped_at: Timestamp | null;
	/** 同 `capped_at`，用 Agent 时间表示。 */
	agent_capped_at: Timestamp | null;
}

/**
 * 一个任务（一次尝试）的一页明细，按开始时间从新到旧（开始时间相同时 ID 大的在前）。
 *
 * 一页的范围：从这一页最早的那条明细（读到最早一页时是任务的开头）到游标（最新一页时是现在），`count_only`
 * 是起点（`from`）落在这个范围里的只计数的段，所以一直往前翻，每一段正好出现一次。
 */
export interface ActionPage {
	task_id: string;
	actions: ActionDetailView[];
	/** 读更早的一页：下一次请求的 before；没有更早的明细时为 null。 */
	before: string | null;
	/**
	 * 起点落在这一页范围里的只计数的段，从新到旧。只看失败时，`name_limit` 的段只在合计也满了时才有：合计没满时，
	 * 超过每种名称上限之后失败的动作仍有明细。
	 */
	count_only: CountOnlyPeriod[];
	/**
	 * 读这一页那一刻明细的修订号：实时推送（`events`）的 `after` 用它，之后写入或结束的明细都由推送送达。
	 * 最新一页的这个值才有用。
	 */
	rev: number;
	/** 运行已超过保留期、明细已被清理（此时是空页）。 */
	expired: boolean;
}

export interface ActionPageQuery {
	/** 读这个游标之前（更早开始）的明细；不给时读最新的一页。 */
	before?: string;
	/** 一页最多多少条明细（默认 100）。 */
	limit?: number;
	/** 只要这个名称的。 */
	name?: string;
	/** true：只要失败的动作（没有标记）。 */
	failed?: string;
}

/**
 * 一个动作的明细。还在做时结果和结束都为 null；任务结束（成功、失败、取消、`agent_lost`）时还没结束的记为
 * `unfinished`，结束时间取任务的结束时间。
 */
export interface ActionRecordDetail {
	/** 任务内的 ID（动作和标记共用一个序列）。 */
	id: number;
	/** 父动作的 ID；最外层为 null。父动作不一定有明细。 */
	parent: number | null;
	/** 层级：最外层是 0。 */
	depth: number;
	name: string;
	/** 说明字段（值都是文字），按写入的先后；动作的是开始时给的加上之后补充的。 */
	fields: Record<string, string>;
	/** 动作开始、标记发生的控制面时间。 */
	started_at: Timestamp;
	agent_started_at: Timestamp;
	kind: "action";
	/** 结果；还在做时为 null。 */
	result: ActionResult | null;
	/** 结束的控制面时间；还在做时为 null。 */
	ended_at: Timestamp | null;
	/** 结束的 Agent 时间；还在做时，以及任务结束时还没结束、取不到 Agent 时间时为 null。 */
	agent_ended_at: Timestamp | null;
	/** 耗时（毫秒）：按单调时钟算，不受 Agent 系统时间改动的影响；记为未结束的按控制面时间算；还在做时为 null。 */
	duration_ms: number | null;
	/** 失败的原因（最多 `ACTION_LIMITS.reasonChars` 个字符）；其他结果为 null。 */
	reason: string | null;
}

/** 动作的结果：成功、失败、未结束（任务结束时还没结束，或因为取消离开 `with`）。 */
export type ActionResult = "success" | "failed" | "unfinished";

/**
 * 一个任务的动作摘要：任务结束（成功、失败、取消、`agent_lost`）以后 `running` 为空。
 * 正在做的、最近结束的、计数都只取这一份，超出上限前后都准确。
 */
export interface ActionSummaryView {
	/** 动作和标记合计的个数。 */
	total: number;
	/** 其中标记的个数：动作的个数是 total 减去它。 */
	marks: number;
	/** 有明细的个数（最多 100000）。 */
	reported: number;
	/** 有没有超出 SDK 的上限：有动作或标记只计数、没有明细。 */
	capped: boolean;
	/**
	 * 控制面兜底丢弃过这个任务的明细（被改过的 SDK 写出超过上限的明细时，规格 #345 故事 49）。SDK 的上限没超时 `capped`
	 * 也可能是 false；哪些名称从几点起只计数在明细分页的 `count_only` 里（`reason` 为 `control_plane`）。
	 */
	control_plane_capped: boolean;
	/** 合计已满、开始丢弃明细的时刻；没有丢弃过时为 null。不是明细的终点：之后仍可能有补上的失败的动作。 */
	capped_at: Timestamp | null;
	/** 同 `capped_at`，用 Agent 时间表示。 */
	agent_capped_at: Timestamp | null;
	/** 每种名称一项，按第一次出现的先后。 */
	names: ActionNameCount[];
	/** 正在做的动作，最多 `ACTION_LIMITS.running` 个（层级浅的优先），按 ID 排列。 */
	running: RunningActionView[];
	/** `running` 是不是全部正在做的动作：列满 `ACTION_LIMITS.running` 个时为 false，可能还有没列出的。 */
	running_complete: boolean;
	/** 最近结束的 `ACTION_LIMITS.recent` 个动作，最近结束的在前。 */
	recent: EndedActionView[];
	/** 最近失败的 `ACTION_LIMITS.recentFailed` 个动作，最近失败的在前。 */
	recent_failed: EndedActionView[];
}

/**
 * 加一个包节点。`id` 不写时按画布的规则生成（节点名加序号，例如 `check_1`）。`after` 写了就接在那个节点后面：
 * 它是链尾时追加，后面还有节点时插在它和下一个节点之间（和画布上「在后面添加」一样）。
 * 包还没有锁定时一起锁定：`version` 写了用它，不写时用最新发布的版本，没有发布过、只有在线的 Agent 加载着开发版本时用 `dev`；
 * 已经锁定的包只能用锁定的版本。
 */
export interface AddNodeOperation {
	op: "add_node";
	/** 只能用字母、数字、下划线和连字符（输出的引用里要写它）。 */
	id?: string;
	package: PackageName;
	node: NodeName;
	version?: string;
	after?: string;
	/** 节点的输入：常量或含 `${{ ... }}` 引用的字符串。必填的输入要给出。 */
	inputs?: Record<string, unknown>;
	display_name?: string;
	note?: string;
	agent?: string;
	always?: boolean;
	timeout?: number;
	retries?: number;
	queue_timeout?: number;
}

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
	/** 在等这台 Agent 的任务，按排队顺序（也是派发顺序）。 */
	queued_tasks: QueuedTaskView[];
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

/**
 * 注释框：给一组节点和子流程画的框，带标题和备注，说明它们合起来在场景里做什么。属于版本内容，只记成员、
 * 不存坐标和大小，框的范围由成员算出（@sfly/orchestration 的 annotationBoxes，ADR 0023）；
 * 只用于显示，不影响执行（docs/SEMANTICS.md §1.6）。
 */
export interface Annotation {
	/** 注释框之间唯一（重复时文档不合法）；画布新建时自动生成，例如 `annotation_1`。 */
	id: string;
	title: string;
	note?: string;
	/** 颜色，不写就是灰色；画布新建的注释框不写，选灰色时也去掉这一项。 */
	color?: AnnotationColor;
	/** 成员节点的节点 ID。 */
	nodes: string[];
	/** 成员子流程：子流程入口的节点 ID（和停止子流程节点一样，子流程改名不影响）。 */
	subflows: string[];
}

export type AnnotationColor = "gray" | "blue" | "green" | "yellow" | "orange" | "pink";

/**
 * 注释框：给一组节点和子流程画的框，带标题和备注，说明它们合起来在场景里做什么。属于版本内容，只记成员、
 * 不存坐标和大小，框的范围由成员算出（@sfly/orchestration 的 annotationBoxes，ADR 0023）；
 * 只用于显示，不影响执行（docs/SEMANTICS.md §1.6）。
 */
export interface AnnotationInput {
	/** 注释框之间唯一（重复时文档不合法）；画布新建时自动生成，例如 `annotation_1`。 */
	id: string;
	title: string;
	note?: string;
	/** 颜色，不写就是灰色；画布新建的注释框不写，选灰色时也去掉这一项。 */
	color?: AnnotationColor;
	/** 成员节点的节点 ID。 */
	nodes?: string[];
	/** 成员子流程：子流程入口的节点 ID（和停止子流程节点一样，子流程改名不影响）。 */
	subflows?: string[];
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

/** 助手正在输出的那条消息的增量文字。助手服务产生，对应 pi 的 `text_delta`。不存。#540 起。 */
export interface AssistantDeltaEvent {
	type: "assistant_delta";
	text: string;
}

export interface AsyncTaskNode {
	id: string;
	/** 布局属于版本内容。 */
	position?: {
		x: number;
		y: number;
	};
	/** 备注：多行说明，写这个节点做什么、为什么这样配置。属于版本内容，只用于显示，不影响执行（docs/SEMANTICS.md §1.5）。 */
	note?: string;
	display_name?: string;
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
	/** 备注：多行说明，写这个节点做什么、为什么这样配置。属于版本内容，只用于显示，不影响执行（docs/SEMANTICS.md §1.5）。 */
	note?: string;
	display_name?: string;
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
	/** 执行器启动的时间；排队、准备中为 null。 */
	started_at: Timestamp | null;
	ended_at: Timestamp | null;
	/**
	 * 任务开始、结束时的时钟偏差（ADR 0018）：Agent 在执行器启动、得到结果那一刻的 Agent 时间减去当时的控制面时间；
	 * measured_at 加 offset_ms 就是那一刻的 Agent 时间。started_at / ended_at 仍是控制面收到消息的时刻。
	 * 旧版本 Agent、升级之前的任务、不在 Agent 上执行的节点、不是由 Agent 上报而结束的任务为 null。
	 */
	start_clock_offset: ClockOffsetView | null;
	end_clock_offset: ClockOffsetView | null;
	progress: TaskProgressView | null;
	/** 执行中的尝试此刻在做的动作（见 CurrentAction）；没有时为 null，尝试结束后也为 null。 */
	current_action: CurrentAction | null;
	/** 排队中（`status` 为 queued）的尝试在等什么；其余状态为 null。 */
	queue_wait: QueueWaitView | null;
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
 * 检查时的一条警告（#424）：和保存时的一样，再加一个标记——改动之前（最新版本里）是不是就有。
 * 「同一条」按警告的种类（`code`）加它指向的对象（`node_id`、`input`、`annotation_id`、`target`）判断，不看文字：
 * 同一种警告指向另一个节点算新的；同一个对象上同一种警告有几条，最新版本里有几条就有几条算已有（按出现的顺序）。
 * 会失效的运行预设（`preset_invalidated`）说的就是这次改动，总是新的；场景还没有版本时全部是新的。
 */
export interface CheckedWarningView {
	code: string;
	message: string;
	node_id?: string;
	/** 警告所指的字段：包节点的输入、子流程参数、入口参数（`secret_param_default` 是参数名）、节点配置的字段。 */
	input?: string;
	annotation_id?: string;
	/**
	 * 同一个节点（或注释框）上可能有两条同种警告时，具体是哪一个：引用的警告是引用的路径，注释框指向成员的警告是
	 * `nodes/<节点 ID>` 或 `subflows/<子流程入口节点 ID>`，连线的警告是 `起点->终点:种类`，停止子流程节点的警告是它要停的子流程入口 ID，
	 * 会失效的运行预设是预设的名称。用来认出「同一条警告」（见 CheckedWarningView），界面上不显示。
	 */
	target?: string;
	/** true：改动之前就有，不是这次改动带进来的（`sfly scenario check` 的退出码和 `push --strict` 不看它）。 */
	existing: boolean;
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

/** 提交里一个文件的改动；`additions`、`deletions` 是增、删的行数，二进制文件为 null。 */
export interface CommitFile {
	path: string;
	additions: number | null;
	deletions: number | null;
}

/** 加一条连线，规则和画布上连线一样（链不分叉、不汇合、不成环；调度连线从异步任务节点连到子流程入口）。 */
export interface ConnectOperation {
	op: "connect";
	from: string;
	to: string;
	kind?: "chain" | "dispatch";
}

/**
 * 复制场景的响应（#576）：新场景，加上第 1 版的警告，和保存、恢复版本的响应里的 `warnings` 同一套。复制把源场景最新版本的
 * 文档原样写成新场景的第 1 版，不过保存时的检查：升级前保存的版本里超限的超时、排队超时照样复制，问题在这里带出来。
 * 源场景还没有版本（`head_version` 为 0）时为空。
 */
export interface CopiedOrchestrationView {
	id: string;
	name: string;
	description: string;
	/** 最新版本号；0 表示还没有保存过版本。 */
	head_version: number;
	created_at: Timestamp;
	/** 归档时间；没有归档时为 null。 */
	archived_at: Timestamp | null;
	/** 运行结束时发给飞书机器人的通知设置（`bot` 为 null 即关闭）。 */
	run_notification: RunNotificationSettings;
	/** 关注项，按作者设定的顺序；每项带它在最新版本里的状态。场景列表不带这个字段。 */
	focus_items: FocusItemView[];
	/** 关注项最后一次修改；从没改过（也没有复制过关注项）时为 null。 */
	focus_edit: FocusEditView | null;
	warnings: DocumentWarningView[];
}

/**
 * 只计数的一段：这段时间里有动作或标记只计数、没有明细。
 *
 * - `name_limit`：这个名称超过了每种名称的上限（`ACTION_LIMITS.perName`），失败的动作仍有明细，不在 `count` 里；
 * - `total_limit`：合计超过了上限（`ACTION_LIMITS.total`），之后所有名称都只计数，失败的也是；
 * - `control_plane`：控制面兜底丢弃（被改过的 SDK 写出了超过上限的明细）。
 *
 * 每种名称、每种原因至多一段；算法见 docs/ARCHITECTURE.md §6.3。
 */
export interface CountOnlyPeriod {
	name: string;
	reason: "name_limit" | "total_limit" | "control_plane";
	/** 从什么时候起（控制面时间、Agent 时间）：第一个没有明细的动作或标记的时刻。 */
	from: Timestamp;
	agent_from: Timestamp;
	/** 到什么时候：任务已结束时是任务的结束时间；还在执行时为 null（至今）。 */
	to: Timestamp | null;
	/** 这一段里没有明细的个数。 */
	count: number;
}

/** `POST /projects/:project/sessions`：新建会话，`text` 是它的第一句话，作为第一轮。 */
export interface CreateSessionBody {
	text: SessionMessageText;
}

/**
 * 执行中的任务此刻在做的事：最外层（第 0 层）、开始得最早的那个正在做的动作（运行视图的尝试、
 * Agent 列表里正在执行的任务都带它）。没有正在做的最外层动作、或者任务不在执行中时为 null。
 */
export interface CurrentAction {
	name: string;
	/** 开始的控制面时间。 */
	started_at: Timestamp;
}

/**
 * 控制台运行块里进行中的节点：运行列表的 `active_nodes` 一项，排队中的节点多两个字段，写明它在等什么
 * （运行监控概览里同一件事的写法，#457）。其余状态的节点两个字段都是 null。
 */
export interface DashboardActiveNode {
	chain_instance_id: string;
	node_id: string;
	/** 节点的显示名称（子流程入口节点是子流程名称），取自运行绑定的场景版本；没有时不给。 */
	display_name?: string;
	status: string;
	/** 最后一次尝试的尝试号（从 1 开始）。 */
	attempt: number;
	/** 任务所在的 Agent（排队中的任务是它在等的 Agent）；不在 Agent 上执行的节点（停止子流程节点）为 null。 */
	agent: string | null;
	/** 最后一次尝试开始的时间；还没开始执行（排队中、准备中）时为 null。 */
	started_at: Timestamp | null;
	/** 最新进度；没有上报过时为 null。 */
	progress: {
		current: number;
		total: number | null;
	} | null;
	/**
	 * 排队中的节点：它在等什么（同运行视图里排队中的尝试的 `queue_wait`，控制面读取这一刻按派发的条件判断）；
	 * 排队中但没有可等的 Agent（没有指定 Agent）时和其余状态一样为 null。
	 */
	queue_wait: QueueWaitView | null;
	/** 最后一次尝试进入排队的时间（「排了多久」用它）；只有 `queue_wait` 有值时有值。 */
	queued_at: Timestamp | null;
}

export interface DashboardAgentStats {
	online: number;
	offline: number;
	/** 在线 Agent 的槽位合计与占用。 */
	slots: number;
	used_slots: number;
}

/** 运行中的链实例：节点按链上的顺序，状态与运行视图一致（pending、queued、running、success…）。 */
export interface DashboardChain {
	id: string;
	chain_id: string;
	/** 子流程实例（不是主链）。 */
	subflow: boolean;
	/**
	 * 子流程名称（与运行视图里链实例的 name 相同：没有名称字段的旧版本为子流程入口的节点 ID，名称为空时为空字符串），
	 * 取自运行绑定的场景版本；主链不给。
	 */
	subflow_name?: string;
	/** 触发这个子流程实例的异步任务节点所在的链实例；主链为 null。 */
	parent_chain_instance_id: string | null;
	/** 触发这个子流程实例的异步任务节点；主链为 null。 */
	async_node_id: string | null;
	status: string;
	nodes: {
		node_id: string;
		/** 节点的显示名称（子流程入口节点是子流程名称），取自运行绑定的场景版本；没有时不给。 */
		display_name?: string;
		status: string;
	}[];
}

/**
 * 最近结束的一个运行。失败的带上最先出问题的节点；运行的任务记录里找不到失败的节点时（数据不完整，正常运行不会出现）
 * failure 为 null。失败的还带 `focus`：场景现在的关注项在这次运行结束时的值。
 */
export type DashboardEndedRun = {
	id: string;
	orchestration_id: string;
	orchestration_name: string;
	orchestration_version: number;
	/** 触发人的昵称。 */
	triggered_by: string;
	started_at: Timestamp;
	ended_at: Timestamp;
	status: "failed";
	failure: DashboardRunFailure | null;
	/**
	 * 场景现在的关注项（不是运行时的，结束后改的也算）在这次运行结束时的读数：和 `GET /runs/:id/focus?points=0` 同一份
	 * 解析规则（有异常的在最前，不带序列），取前 `DASHBOARD_ENDED_FOCUS_MAX` 项；场景没设关注项时是空数组
	 * （不取执行中节点的主指标，运行已经结束）。
	 */
	focus: RunFocusItem[];
} | {
	id: string;
	orchestration_id: string;
	orchestration_name: string;
	orchestration_version: number;
	/** 触发人的昵称。 */
	triggered_by: string;
	started_at: Timestamp;
	ended_at: Timestamp;
	status: "success" | "cancelled";
};

/** 失败的运行最先出问题的地方：跨所有链，最后一次尝试失败、最先结束的节点和它所在的链。 */
export interface DashboardRunFailure {
	chain_instance_id: string;
	chain_id: string;
	subflow: boolean;
	/**
	 * 子流程名称（与运行视图里链实例的 name 相同：没有名称字段的旧版本为子流程入口的节点 ID，名称为空时为空字符串），
	 * 取自运行绑定的场景版本；主链不给。
	 */
	subflow_name?: string;
	node_id: string;
	/** 失败节点的显示名称（子流程入口节点是子流程名称），取自运行绑定的场景版本；没有时不给。 */
	display_name?: string;
	/** 失败节点最后一次尝试的尝试号。 */
	attempt: number;
	/** 这次尝试的错误（含出错位置，见 `ErrorView`），其中的 secret 值已打码。 */
	error: ErrorView | null;
}

export interface DashboardRunStats {
	/** 正在运行的运行数（含取消中的）。 */
	running: number;
	/** 正在运行的链实例数（主链与子流程）。 */
	running_chains: number;
	/** 已派发给 Agent、还没结束的任务数（准备中与执行中）。 */
	running_tasks: number;
	/** 排队等待 Agent 的任务数。 */
	queued_tasks: number;
	success: number;
	failed: number;
	cancelled: number;
	/** 窗口内失败的子流程实例数（不论所在运行是否已结束）。 */
	failed_subflows: number;
}

export interface DashboardRunningRun {
	id: string;
	orchestration_id: string;
	orchestration_name: string;
	orchestration_version: number;
	/** 触发人的昵称。 */
	triggered_by: string;
	/** 经哪个 AI 编程助手触发；没有时为 null（与运行列表的 `triggered_via` 相同）。 */
	triggered_via: string | null;
	started_at: Timestamp;
	/** 已请求取消、正在清理（运行状态仍是 running）。 */
	cancelling: boolean;
	/** 主链在前，子流程按深度、开始时间。 */
	chains: DashboardChain[];
	/** 进行中的节点（运行列表的 `active_nodes`，排队中的多写明在等什么）。 */
	active_nodes: DashboardActiveNode[];
}

/**
 * 「开始使用」的四步（外壳页方案第 5 节）：各自是否完成，以及写在步骤上的事实。四步互不依赖，各自从现有数据判断；
 * 出现第一个运行（`run.done`）之后控制台不再显示这个面板。
 */
export interface DashboardSetup {
	/** 接入一台 Agent：有在线的 Agent 就算完成。 */
	agent: {
		done: boolean;
		/** 在线的 Agent 数。 */
		online: number;
		/** 名称排在最前的在线 Agent；没有在线的为 null。 */
		name: string | null;
	};
	/** 发布节点包：已经发布过任何一个版本就算完成。 */
	package: {
		done: boolean;
		/** 已发布的节点包个数（按包名，不计版本数）。 */
		count: number;
		/** 最近发布的版本；还没有为 null。 */
		latest: {
			name: string;
			version: string;
		} | null;
	};
	/** 新建场景：有没有归档的场景就算完成。 */
	scenario: {
		done: boolean;
		/** 没有归档的场景数。 */
		count: number;
		/** 最近新建的、没有归档的场景名称；没有为 null。 */
		name: string | null;
	};
	/** 触发第一次运行：有过任何一个运行（不论结果、不论场景是否已归档）就算完成。 */
	run: {
		done: boolean;
	};
}

export interface DashboardView {
	/** 统计的时刻（控制面时钟），窗口的终点。 */
	generated_at: Timestamp;
	runs: DashboardRunStats;
	/** 正在运行的运行，按开始时间从新到旧。 */
	running_runs: DashboardRunningRun[];
	/** 窗口内结束的运行，按结束时间从新到旧（最多 10 个）。 */
	recent_ended: DashboardEndedRun[];
	/** Agent 的在线数与槽位合计；每台 Agent 的状态与正在执行的任务用 Agent 列表接口（agentsApi.list）。 */
	agents: DashboardAgentStats;
	/** 「开始使用」四步各自的完成情况；出现第一个运行之后控制台不再显示这个面板。 */
	setup: DashboardSetup;
}

/** Agent 上以开发模式（sfly dev）加载的节点包；metadata 是加载时扫描出的元信息，未经发布校验。 */
export interface DevPackageView {
	name: string;
	source: string;
	metadata: Record<string, unknown> | null;
}

/** 差异里的一个节点：ID、种类，有显示名称时带上（子流程入口节点是子流程名称）。 */
export interface DiffNodeView {
	id: string;
	kind: string;
	display_name?: string;
}

/** 断开一条连线；没有这条连线时这个操作不合法。 */
export interface DisconnectOperation {
	op: "disconnect";
	from: string;
	to: string;
	kind?: "chain" | "dispatch";
}

/**
 * 两份场景文档的差异（@sfly/orchestration 的 diffDocuments，前端的版本对比用的是同一个函数）：只列出差异，不做合并。
 * 节点、注释框按 ID 对应，连线按（起点、终点、种类）对应。`moved` 是两边都有、只是位置变了的节点。
 * secret 参数的默认值两边都是占位符，它的值变了看不出来。
 */
export interface DocumentDiffView {
	/** 场景级设置：默认 Agent（`default_agent`）、锁定的节点包版本（`packages.<包名>`）。 */
	settings: FieldChangeView[];
	/** 改动的节点逐项列出字段：包节点的输入是 `inputs.<名>`，入口和子流程入口的参数是 `params.<参数名>`。 */
	nodes: {
		added: DiffNodeView[];
		removed: DiffNodeView[];
		changed: {
			id: string;
			kind: string;
			display_name?: string;
			changes: FieldChangeView[];
		}[];
	};
	edges: {
		added: {
			from: string;
			to: string;
			kind: string;
		}[];
		removed: {
			from: string;
			to: string;
			kind: string;
		}[];
	};
	moved: string[];
	annotations: {
		added: {
			id: string;
			title: string;
		}[];
		removed: {
			id: string;
			title: string;
		}[];
		changed: {
			id: string;
			title: string;
			changes: FieldChangeView[];
		}[];
	};
}

/**
 * 保存时返回的静态检查警告（@sfly/orchestration 的 documentWarnings）；只提示，不阻止保存。
 * 注释框的警告带 `annotation_id`，指出是哪个注释框；它们也不阻断触发。
 */
export interface DocumentWarningView {
	code: string;
	message: string;
	node_id?: string;
	/** 警告所指的字段：包节点的输入、子流程参数、入口参数（`secret_param_default` 是参数名）、节点配置的字段。 */
	input?: string;
	annotation_id?: string;
	/**
	 * 同一个节点（或注释框）上可能有两条同种警告时，具体是哪一个：引用的警告是引用的路径，注释框指向成员的警告是
	 * `nodes/<节点 ID>` 或 `subflows/<子流程入口节点 ID>`，连线的警告是 `起点->终点:种类`，停止子流程节点的警告是它要停的子流程入口 ID，
	 * 会失效的运行预设是预设的名称。用来认出「同一条警告」（见 CheckedWarningView），界面上不显示。
	 */
	target?: string;
}

export interface Edge {
	from: string;
	to: string;
	/** chain：链上的顺序连线；dispatch：异步任务节点 → 子流程入口节点的调度连线。 */
	kind: "chain" | "dispatch";
}

export type EditOperation = AddNodeOperation | RemoveNodeOperation | ConnectOperation | DisconnectOperation | SetFieldOperation;

export type EditOperations = EditOperation[];

/** 一个已经结束的动作。 */
export interface EndedActionView {
	/** 任务内的动作 ID（动作和标记共用一个序列），先后不一定是开始的先后。 */
	id: number;
	/** 父动作的 ID；最外层为 null。父动作不一定还在摘要里。 */
	parent: number | null;
	/** 层级：最外层是 0。 */
	depth: number;
	name: string;
	/** 说明字段（值都是文字），开始时给的加上之后补充的。 */
	fields: Record<string, string>;
	/** 开始的控制面时间。 */
	started_at: Timestamp;
	/** 开始的 Agent 时间。 */
	agent_started_at: Timestamp;
	ended_at: Timestamp;
	agent_ended_at: Timestamp;
	/** 耗时（毫秒），按单调时钟算，不受 Agent 系统时间改动的影响。 */
	duration_ms: number;
	result: ActionResult;
	/** 失败的原因（最多 `ACTION_LIMITS.reasonChars` 个字符）；其他结果为 null。 */
	reason: string | null;
}

export interface EntryNode {
	id: string;
	/** 布局属于版本内容。 */
	position?: {
		x: number;
		y: number;
	};
	/** 备注：多行说明，写这个节点做什么、为什么这样配置。属于版本内容，只用于显示，不影响执行（docs/SEMANTICS.md §1.5）。 */
	note?: string;
	display_name?: string;
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
	/** 备注：多行说明，写这个节点做什么、为什么这样配置。属于版本内容，只用于显示，不影响执行（docs/SEMANTICS.md §1.5）。 */
	note?: string;
	display_name?: string;
	kind: "entry";
	params?: ParamDeclarationInput[];
}

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
 * 各项：`unreachable` 连不上或连接断开，`timeout` 超时，`auth` 密钥被拒绝，`quota` 额度不足，`rate_limit` 限流，
 * `upstream` 对方出错，`context_overflow` 上下文超长，`other` 其他。
 */
export type ErrorClass = "unreachable" | "timeout" | "auth" | "quota" | "rate_limit" | "upstream" | "context_overflow" | "other";

/**
 * 错误：kind 是错误类型（node_error、timeout、agent_lost、env_error、config_error）；message 可能带堆栈（空行之后）。
 * location 是节点失败时出错的位置：节点代码里的那一行，写成「模块.函数 第 N 行」（SDK 的执行器取，堆栈不带执行器自己的帧）；
 * 不是节点自己出错、取不到位置、旧版本 Agent 或 SDK 上报的、升级之前的任务为 null。
 */
export interface ErrorView {
	kind: string;
	message: string;
	location: string | null;
}

/** 机器人名称：去掉首尾空白后 1 到 `FEISHU_BOT_NAME_MAX` 个字符。 */
export type FeishuBotName = string;

/**
 * 一处引用飞书机器人的地方。`kind` 区分引用的种类：「飞书机器人」类型的输入的常量值（`feishu_bot_input`，指出节点和输入名）、
 * 场景设置里的运行通知（`run_notification`，场景自己的设置，不在某个节点上）。
 */
export type FeishuBotReference = {
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

/** 「发送测试消息」的结果；失败也是 200，结果在 `ok` 里。 */
export interface FeishuTestResult {
	/** 消息有没有送达。 */
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

/** 一项字段的变化：`path` 例如 `default_agent`、`packages.http`、`inputs.url`、`params.env`；前后值不存在时没有这个字段。 */
export interface FieldChangeView {
	path: string;
	/** 改之前的值；之前没有这一项（新加的输入、参数、包）时没有这个字段。 */
	before?: unknown;
	/** 改之后的值；之后没有这一项（删掉的输入、参数、包）时没有这个字段。 */
	after?: unknown;
}

/** 一项的异常；没有异常为 null。 */
export interface FocusAnomaly {
	kind: FocusAnomalyKind;
	/** `log` 时是最近一条日志的级别。 */
	level?: "warn" | "error";
	/**
	 * 异常发生的时间（控制面时间）：`log` 是最近一条 WARN / ERROR 的时间，`stale` 是最后一个点的时间（一个点都没有时是
	 * 这次尝试开始执行的时间），`failed` 是失败的时间，`retry` 是这次尝试开始执行的时间（还没开始时是进入排队的时间）。
	 */
	at: Timestamp;
	/**
	 * 原因的原文，截到 500 个字符：`log` 是那一条日志的正文；`failed` 是这次尝试的错误信息、`retry` 是上一次尝试的错误信息，
	 * 两者都只取第一行（之后是堆栈）；没有原文（`stale`，或没有错误信息）时是空串。
	 */
	message: string;
	/** `log` 时是这次尝试里 WARN / ERROR 的总条数（日志截断时写的截断标记也算一条，之后的行不再计数）。 */
	count?: number;
}

/**
 * 异常的四种原因（规格 #344）：
 * - `log`：来源任务最近一条 WARN / ERROR 在 10 分钟以内；
 * - `stale`：来源节点在执行中（准备中、执行中），距离最后一个点超过「30 秒」和「6 倍采样间隔」里大的那个；
 *   点不够两个时只按 30 秒判断，一个点都没有时从这次尝试开始执行算起（还没开始执行的准备中节点不判断）；
 * - `failed`：来源节点失败；
 * - `retry`：最新一次尝试的号大于 1，并且是 10 分钟以内开始的（还没开始执行时按进入排队的时间）。
 *
 * 同时满足几种时按 failed、log、retry、stale 的顺序只报一种。来源节点成功、已停止或已取消（`final`）时不判断。
 * 时间一律按控制面时间（ADR 0018），判断只在控制面做，各页面都用这一份结果。
 */
export type FocusAnomalyKind = "log" | "stale" | "failed" | "retry";

/** 关注项最后一次修改：谁、什么时候（控制面时间）、一句话说明改了什么（控制面比较新旧列表生成）。 */
export interface FocusEditView {
	/** 修改人的昵称。 */
	updated_by: string;
	updated_at: Timestamp;
	/** 例如「添加了「TPS」」「把「下单延迟」移到第 6 位」「撤销了移除「TPS」」「复制自「撮合浸泡」」。 */
	summary: string;
}

/**
 * 请求里的一个关注项（GLOSSARY「关注项」）：来源节点的 ID，和图表的标题（按标题引用，节点包元信息不给图表加 ID），
 * 以及场景作者起的名字：不写、或者去掉首尾空白后为空，都是没起名，显示时用图表标题。名字只能写一行。
 */
export interface FocusItemInput {
	/** 来源节点的 ID。 */
	node_id: string;
	/** 图表的标题（节点类型在元信息里声明的）。 */
	chart: string;
	/** 场景作者起的名字；不写即没起名，显示时用图表标题。 */
	title?: string;
}

/**
 * 关注项和场景最新版本的对照（`status`）：
 *
 * - `ok`：节点在最新版本里，它锁定的节点包版本声明了这张图表（含平台为没被图表引用的指标生成的默认图表），带这张图表的类型 `chart_type`。
 * - `node_missing`：节点不在最新版本里。`last_version` 是包含它的最后一个版本号；没有任何版本包含它时为 null
 *   （复制场景时带过来的关注项）。运行绑定在这个版本及更早的版本时，这一项照常显示。
 * - `chart_missing`：节点还在，但它锁定的节点包版本没有这张图表（图表改了标题、节点类型换了，或者节点已不是包节点）。
 *
 * 失效的项（后两种）保留在列表里，也占名额。
 */
export type FocusItemView = {
	node_id: string;
	chart: string;
	/** 场景作者起的名字；没起名时没有这个字段，显示时用 `chart`。 */
	title?: string;
	status: "ok";
	/** 图表在最新版本里声明的类型（`stat` 是数值卡，显示成数值，其余照声明画）。 */
	chart_type: "line" | "area" | "bar" | "stat";
} | {
	node_id: string;
	chart: string;
	/** 场景作者起的名字；没起名时没有这个字段，显示时用 `chart`。 */
	title?: string;
	status: "node_missing";
	last_version: number | null;
} | {
	node_id: string;
	chart: string;
	/** 场景作者起的名字；没起名时没有这个字段，显示时用 `chart`。 */
	title?: string;
	status: "chart_missing";
};

/** 读数的最新值：最近更新的那个序列的最后一个点。 */
export interface FocusLatest {
	value: number;
	/** 这个点所在序列的指标名和标签；不带标签的序列标签为 `{}`。 */
	metric: MetricName;
	labels: MetricLabels;
	/** 这个点的控制面时间（按秒取整）。 */
	at: Timestamp;
}

/** 一项读的指标：名字和声明的标签键（序列名里标签值按这个顺序排；不带标签的指标是空数组）。 */
export interface FocusMetric {
	name: MetricName;
	label_keys: MetricName[];
}

/** 序列里的一个桶：起始时间（控制面时间）、桶内的最小、最大值、平均值和最新值。 */
export interface FocusPoint {
	/** 桶的起始时间；升级之前存下的数据没有控制面时间，用它的 Agent 时间。 */
	time: Timestamp;
	min: number;
	max: number;
	/** 桶里所有点的平均值。 */
	avg: number;
	/** 桶里最后一个点的值。 */
	last: number;
	/** 桶里有几个点。 */
	points: number;
}

export interface FocusSeries {
	metric: MetricName;
	labels: MetricLabels;
	/** 按时间升序，每 `bucket_seconds` 秒一个桶，没有点的桶不给。 */
	points: FocusPoint[];
}

/** 来源节点和它最新一次尝试的任务。 */
export interface FocusSource {
	/** 来源节点的状态，取法与运行视图里的节点状态一致。 */
	status: NodeStatus;
	/** 最新一次尝试的序号；节点还没有尝试时为 0。 */
	attempt: number;
	/** 最新一次尝试的任务；节点还没有尝试时为 null。 */
	task_id: string | null;
	/** 节点所在的链实例；节点所在的子流程还没有触发（还没有链实例）时为 null。 */
	chain_instance_id: string | null;
	/** 这次尝试开始、结束的时间，图表的横轴从开始画到结束（还没结束就画到 `generated_at`）；没有就是 null。 */
	started_at: Timestamp | null;
	ended_at: Timestamp | null;
}

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
	/** 触发人的昵称。 */
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

/**
 * 按时刻定位（`at`）的结果。「正好对应」：行的控制面时间与 `at` 相差不超过 50 毫秒（含），并且这个范围里只有这一行；
 * 有几行时分不出是哪一笔的，算没有。没有控制面时间的旧行从不算。判断只在筛选（`level`、`source`）之后的行里做，没有符合的行就是没有。
 */
export interface LogLocate {
	/**
	 * 那一刻在日志文件里的位置：这个字节偏移之前的行，控制面时间都早于 `at`（旧行没有控制面时间，算在前面）；
	 * 这个偏移起的行都不早于 `at`。晚于最后一行时是日志文件的大小，没有日志时是 0。
	 */
	at_offset: number;
	/** 正好对应那一刻的行的序号；没有这样的行时为 null，页面改为在 `at_offset` 的位置标出这一刻。 */
	exact_seq: number | null;
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
	/** 请求带了 `at` 时的定位结果；`end` 小于 `size` 说明这一页之后还有行，没带 `at` 时为 null。 */
	locate: LogLocate | null;
}

export interface LogPageQuery {
	/** 往前翻页：读这个字节偏移之前的行（默认文件末尾）。 */
	before?: number;
	/** 往后翻页：读这个字节偏移之后的行。不能与 before 同时给。 */
	after?: number;
	/** 一页最多多少行（默认 200）。 */
	limit?: number;
	/** 只要这些级别，逗号分隔。 */
	level?: string;
	/** 只要这些来源，逗号分隔。 */
	source?: string;
	/**
	 * 定位到这个时刻（控制面时间）：返回包含那一刻的一页，前后各取一半（不足的一侧由另一侧补满），
	 * 响应的 `locate` 写明那一刻的位置和有没有正好对应的行。不能与 before、after 同时给。
	 */
	at?: Timestamp;
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
		/**
		 * 这个序列在查询范围里最后一个点的控制面时间（按秒取整，不随降采样变粗：同一个桶里的几个序列也分得出谁更新）；
		 * 没有点为 null。最新值取最近更新的序列（`latestSeries`），和关注项读数的 `latest` 同一个取法。
		 */
		last_at: Timestamp | null;
	}[];
}

/**
 * 序列查询的查询参数：节点（链实例 × 节点）、可选的尝试（默认最新一次）、
 * 指标名（逗号分隔，默认节点类型声明的全部指标）、时间范围（控制面时间，ISO，闭区间，按秒取整；默认数据的首尾时间）、
 * 目标点数（桶数上限）。
 */
export interface MetricSeriesQuery {
	/** 链实例 id（运行视图里 `chains[].id`）。 */
	chain_instance_id: string;
	/** 节点 ID。 */
	node_id: string;
	/** 第几次尝试，从 1 开始；不给是最新一次。 */
	attempt?: number;
	/** 只要这些指标，逗号分隔；不给是节点类型声明的全部指标。 */
	metrics?: string;
	/** 时间范围的起点（控制面时间，闭区间，按秒取整）；不给是数据的第一个点。 */
	from?: Timestamp;
	/** 时间范围的终点；不给是数据的最后一个点。 */
	to?: Timestamp;
	/** 目标点数（降采样的桶数上限，默认 300）。 */
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
	/** 节点的显示名称（子流程入口节点是子流程名称），取自运行绑定的场景版本；没有时不给。 */
	display_name?: string;
	/** 运行绑定的版本是已移除的节点种类（ADR 0028）时，就是它当时的种类名：历史运行照常能看。 */
	kind: "entry" | "subflow_entry" | "async" | "stop_subflow" | "package" | "feishu_notify" | "timer" | "sleep";
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
	/**
	 * 节点类型的说明：节点函数的文档字符串（去掉缩进，可以多段），显示在「添加节点」菜单（第一段）、
	 * 节点包管理页（第一段）和检查器的「说明」页（全文）。只用于显示；没有文档字符串时没有这个字段。
	 */
	description?: string;
	/**
	 * 节点类型声明的默认超时（秒，`@node(timeout=…)`）：场景里这个节点没写超时时用它，都没有时用平台默认的 1 小时
	 * （docs/SEMANTICS.md §3.3）。没声明的节点类型没有这个字段；带它的包发布到没有这个字段的旧控制面会被拒绝。
	 */
	timeout?: number;
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
export type NoticeKind = "retry" | "retry_end" | "compaction" | "steer_dropped" | "queue_cancelled" | "events_lost" | "context_reset";

/** 可以保存的场景文档：节点都是现在支持的种类（保存、命令行的本地检查、导出给 Python 的 JSON Schema 用它）。 */
export interface OrchestrationDocument {
	default_agent?: string;
	nodes: OrchestrationNodeInput[];
	edges?: Edge[];
	/** 锁定的节点包版本：包名 → 版本（`dev` 表示开发版本）。 */
	packages?: Record<PackageName, string>;
	annotations?: AnnotationInput[];
	/**
	 * 已移除的字段（便签，ADR 0028）：只为兼容旧客户端和升级前导出的文件保留，新写的文档不要带它。
	 * 保存时收到空数组会丢掉（新版本里没有它），里面有内容的被拒绝（400 `invalid_document`，写明有几条、怎么办）。
	 * 读到的文档（`StoredOrchestrationDocument`）里没有这个字段，读出来原样存回去不用处理它。
	 */
	sticky_notes?: unknown[];
}

/** 编辑起点：最新版本；还没有版本时是只含入口节点的初始文档（number 为 0，作者与时间为 null）。 */
export interface OrchestrationHeadView {
	orchestration_id: string;
	number: number;
	/** 保存这个版本的人的昵称；还没有版本时为 null。 */
	author: string | null;
	/** 经哪个 AI 编程助手保存；没有版本或没有经助手时为 null。 */
	author_via: string | null;
	created_at: Timestamp | null;
	document: StoredOrchestrationDocument;
}

export type OrchestrationNode = EntryNode | SubflowEntryNode | AsyncTaskNode | StopSubflowNode | PackageNode;

export type OrchestrationNodeInput = EntryNodeInput | SubflowEntryNodeInput | AsyncTaskNodeInput | StopSubflowNodeInput | PackageNodeInput;

/** 缩略图用的结构：最新版本（没有版本时是只含入口节点的初始文档）的节点与连线，不含参数与布局。 */
export interface OrchestrationStructure {
	nodes: {
		id: string;
		kind: "entry" | "subflow_entry" | "async" | "stop_subflow" | "package" | "feishu_notify" | "timer" | "sleep";
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
	/** 运行结束时发给飞书机器人的通知设置（`bot` 为 null 即关闭）。 */
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
	/** 保存这个版本的人的昵称。 */
	author: string;
	author_via: string | null;
	created_at: Timestamp;
	document: StoredOrchestrationDocument;
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
	/** 运行结束时发给飞书机器人的通知设置（`bot` 为 null 即关闭）。 */
	run_notification: RunNotificationSettings;
	/** 关注项，按作者设定的顺序；每项带它在最新版本里的状态。场景列表不带这个字段。 */
	focus_items: FocusItemView[];
	/** 关注项最后一次修改；从没改过（也没有复制过关注项）时为 null。 */
	focus_edit: FocusEditView | null;
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
	/** 备注：多行说明，写这个节点做什么、为什么这样配置。属于版本内容，只用于显示，不影响执行（docs/SEMANTICS.md §1.5）。 */
	note?: string;
	display_name?: string;
	kind: "package";
	always: boolean;
	package: PackageName;
	node: NodeName;
	/** 未设置时使用编排的默认 Agent。 */
	agent?: string;
	inputs: Record<string, unknown>;
	/** 秒，1 到 4294967295 之间的整数（保存时检查上限）。 */
	timeout?: number;
	retries?: number;
	/** 秒，1 到 4294967295 之间的整数（保存时检查上限，#559）。 */
	queue_timeout?: number;
}

export interface PackageNodeInput {
	id: string;
	/** 布局属于版本内容。 */
	position?: {
		x: number;
		y: number;
	};
	/** 备注：多行说明，写这个节点做什么、为什么这样配置。属于版本内容，只用于显示，不影响执行（docs/SEMANTICS.md §1.5）。 */
	note?: string;
	display_name?: string;
	kind: "package";
	always?: boolean;
	package: PackageName;
	node: NodeName;
	/** 未设置时使用编排的默认 Agent。 */
	agent?: string;
	inputs?: Record<string, unknown>;
	/** 秒，1 到 4294967295 之间的整数（保存时检查上限）。 */
	timeout?: number;
	retries?: number;
	/** 秒，1 到 4294967295 之间的整数（保存时检查上限，#559）。 */
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
	/** 节点类型摘要，「添加节点」菜单用；`description` 是节点类型的完整说明，没有文档字符串时没有这个字段。 */
	nodes: {
		name: string;
		title: string;
		description?: string;
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
	/** 搭场景的人写的一行说明；敏感参数的说明照常给出，只有值打码。 */
	description?: string;
}

export interface ParamDeclaration {
	name: string;
	type: ParamType;
	default?: unknown;
	required: boolean;
	secret: boolean;
	/**
	 * 一行说明：触发表单、子流程参数映射表单和命令行的参数表里显示。属于版本内容，和 `position` 一样；
	 * 只用于显示，不影响执行（docs/SEMANTICS.md §2.1）。
	 */
	description?: string;
}

export interface ParamDeclarationInput {
	name: string;
	type: ParamType;
	default?: unknown;
	required?: boolean;
	secret?: boolean;
	/**
	 * 一行说明：触发表单、子流程参数映射表单和命令行的参数表里显示。属于版本内容，和 `position` 一样；
	 * 只用于显示，不影响执行（docs/SEMANTICS.md §2.1）。
	 */
	description?: string;
}

/**
 * 编排文档：一个编排版本的内容（docs/SEMANTICS.md）。
 * 最小版本：只表达结构，结构与引用规则的校验由控制面完成（保存时警告、触发时阻断）。
 */
export type ParamType = "string" | "number" | "boolean" | "json";

/** 一个持久的会话事件：`PERSISTED_SESSION_EVENT_TYPES` 里的类型，带 `seq` 和 `at`（历史接口返回它）。 */
export type PersistedSessionEvent = {
	type: "user_message";
	/**
	 * 没有送到的那句话（`user_message.message_id`）：`steer_dropped`（插话没有送到模型）和 `queue_cancelled`（排队中的话因停止没有交给助手）
	 * **必须带**，其余种类不能带。页面据此把这一行和那句话对上，不靠 `message` 里引用的文字；同一句话可能有两条 `steer_dropped`
	 * （控制面写了「没有确认送到」、助手服务之后又确认没送到），按它认，显示一次。#544 起。
	 */
	message_id: string;
	text: string;
	steer: boolean;
	author: string;
	author_user_id: string | null;
	seq: number;
	at: Timestamp;
} | {
	type: "turn_started";
	turn: number;
	seq: number;
	at: Timestamp;
} | {
	type: "assistant_message";
	text: string;
	usage: TokenUsage;
	seq: number;
	at: Timestamp;
} | {
	type: "tool_call";
	call_id: string;
	tool: SessionTool;
	title: string;
	seq: number;
	at: Timestamp;
} | {
	type: "tool_result";
	call_id: string;
	is_error: boolean;
	text: string;
	truncated: boolean;
	exit_code?: number;
	diff?: string;
	duration_ms: number;
	seq: number;
	at: Timestamp;
} | {
	kind: NoticeKind;
	type: "notice";
	/** 给人看的一句话。 */
	message: string;
	/** 第几次重试（从 1 起）；只有 `retry`。 */
	attempt?: number;
	/** 最多重试几次；只有 `retry`。 */
	max_attempts?: number;
	/** 多久（毫秒）之后重试；只有 `retry`。 */
	retry_delay_ms?: number;
	/** 重试的原因按什么分（#640 起有值）。 */
	error_class?: ErrorClass;
	/**
	 * 没有送到的那句话（`user_message.message_id`）：`steer_dropped`（插话没有送到模型）和 `queue_cancelled`（排队中的话因停止没有交给助手）
	 * **必须带**，其余种类不能带。页面据此把这一行和那句话对上，不靠 `message` 里引用的文字；同一句话可能有两条 `steer_dropped`
	 * （控制面写了「没有确认送到」、助手服务之后又确认没送到），按它认，显示一次。#544 起。
	 */
	message_id?: string;
	seq: number;
	at: Timestamp;
} | {
	type: "turn_end";
	turn: number;
	outcome: TurnOutcome;
	reason: string;
	steps?: number;
	model_calls?: number;
	duration_ms: number;
	usage?: TokenUsage;
	limit_kind?: TurnLimit;
	/** 重试的原因按什么分（#640 起有值）。 */
	error_class?: ErrorClass;
	seq: number;
	at: Timestamp;
} | {
	type: "platform";
	kind: "commit";
	turn: number;
	hash: string;
	files: CommitFile[];
	diff: string;
	truncated: boolean;
	seq: number;
	at: Timestamp;
} | {
	type: "platform";
	kind: "scenario_version";
	turn: number;
	scenario_id: string;
	name: string;
	version: number;
	seq: number;
	at: Timestamp;
} | {
	type: "platform";
	kind: "run";
	turn: number;
	run_id: string;
	scenario_name: string;
	seq: number;
	at: Timestamp;
} | {
	type: "session_ended";
	by: string;
	seq: number;
	at: Timestamp;
};

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
	/** 时间序列的起点：运行的开始时间（控制面时间）。 */
	from: Timestamp;
	/** 时间序列的终点：运行的结束时间，运行中是现在。 */
	to: Timestamp;
	/** 每个桶的跨度（秒）。 */
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
		/** 各次尝试从进入排队到结束的时长之和（含排队）。 */
		duration_ms: number;
		/** 包节点：各次尝试从进入排队到开始执行（含派发、安装）的时长之和。 */
		queue_ms: number;
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
	/** 目标点数（降采样的桶数上限，默认 120）。 */
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

/** 不能触发的一个原因；预检的警告（不阻断触发）也是这个结构。 */
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
	/** 新名称（场景内唯一）。 */
	name?: PresetName;
	/** 新说明。 */
	description?: PresetDescription;
	/** 预设参数的完整清单（整份替换）；不给就不改预设参数。 */
	params?: PresetParamInput[];
}

/** 预设说明：去掉首尾空白后不超过 `PRESET_DESCRIPTION_MAX` 个字符。 */
export type PresetDescription = string;

/** 预设名称：去掉首尾空白后 1 到 `PRESET_NAME_MAX` 个字符，场景内唯一（区分大小写）。 */
export type PresetName = string;

/**
 * 请求体里的一个预设参数：`{name, value}` 是参数名和固定的值；`{name, keep: true}` 沿用这个预设里这个 secret 参数原来的值
 * （接口不返回 secret 的原值，修改时不重新输入就写它），不能和 `value` 一起给。`keep` 只能用在最新版本里声明为 secret、
 * 并且这个预设里已经有值的参数上（所以新建时不能用）。两项都没有给时 400 `invalid_preset`，指出缺的是 `value`。
 */
export interface PresetParamInput {
	/** 入口参数的名称。 */
	name: string;
	/** 固定的值（预设参数取它保存的值，触发时不能改）。和 `keep` 二选一。 */
	value?: unknown;
	/** 写 `true` 表示沿用这个预设里这个 secret 参数原来的值（接口不返回 secret 的原值）；只能用在已经有值的 secret 参数上。 */
	keep?: true;
}

/**
 * 预设里的一个预设参数。secret 的值不会返回：`value` 是打码后的 `******`，要沿用它就在修改时写 `{name, keep: true}`
 * （`PresetParamInput`），要换掉它就重新给值。
 */
export interface PresetParamView {
	name: string;
	/**
	 * 值是不是打码的 secret：最新版本里这个参数声明为 secret，或者它已不在入口参数里
	 * （原来是不是 secret 无从判断，按 secret 处理）。以最新版本的声明为准，保存之后才变成 secret 的参数同样打码。
	 */
	secret: boolean;
	/** 固定的值；secret 时是 `******`。 */
	value: unknown;
}

/**
 * 预设和最新版本对不上的一处（GLOSSARY「失效的运行预设」）：`missing` 是预设参数已不存在（被删除或改名），
 * `type_mismatch` 是保存的值不符合它现在的类型。
 */
export interface PresetProblemView {
	/** 有问题的预设参数的名称。 */
	param: string;
	/** 给代码按原因分支用；要显示给人看，用 `message`。 */
	reason: "missing" | "type_mismatch";
	/**
	 * 写成一句话的原因：哪个参数、什么问题，类型不对时写明它现在的类型，例如「参数 host 已不存在」。
	 * 控制台和命令行都直接显示它，409 `preset_invalid` 和 `preset_invalidated` 警告的消息里也是同样的写法。
	 */
	message: string;
}

export interface PresetView {
	id: string;
	name: string;
	description: string;
	/** 预设参数，按最新版本入口参数的声明顺序；已不在声明里的排在后面。 */
	params: PresetParamView[];
	/** `invalid` 是失效的运行预设：不能用来触发运行（409 `preset_invalid`），改好之后恢复 `ok`。 */
	status: "ok" | "invalid";
	/** 失效的原因，按参数名称排序；`status` 为 `ok` 时为空。 */
	problems: PresetProblemView[];
	/** 最后修改人的昵称。 */
	updated_by: string;
	/** 最后修改时间（控制面时间）。 */
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

/**
 * 排队中的尝试在等什么：等的那台 Agent 现在为什么没接它。控制面在读取的这一刻按派发的条件判断（在线、准备好环境、
 * 版本与控制面一致、有空闲槽位），不是尝试自己存下来的状态：Agent 上下线、槽位被占或释放不改变运行本身，
 * 所以运行视图没有变化的推送也会过时，页面和命令行在尝试排队期间定时重新读取。
 */
export interface QueueWaitView {
	/** 等的是哪台 Agent（和尝试的 `agent` 相同）。 */
	agent: string;
	/** 读取这一刻的控制面时间：排了多久、离线了多久、多久后排队超时都按它算（命令行不用自己的时钟）。 */
	now: Timestamp;
	/**
	 * offline：Agent 不在线（从没连上过，或已经断开）；preparing：在线，还在准备环境，不接任务；
	 * version_mismatch：版本与控制面不一致，不派新任务；slots_full：在线、已准备好，槽位都被占着（`holders`）；
	 * dispatching：在线、有空闲槽位，正在派发，马上会开始。
	 */
	state: "offline" | "preparing" | "version_mismatch" | "slots_full" | "dispatching";
	/** offline：Agent 最后在线的时间（从没连上过时为 null）；preparing：开始准备环境的时间；其余状态为 null。 */
	since: Timestamp | null;
	/** 排队超时的时间（超过它仍没有派发，任务以 env_error 失败）；没有设置排队超时时为 null。 */
	expires_at: Timestamp | null;
	/** Agent 的槽位总数；Agent 不在线时为 null。 */
	slots: number | null;
	/** slots_full：占着槽位的任务，按派发顺序；其余状态为空数组。只列读这个运行的人所在项目里的任务。 */
	holders: SlotHolderView[];
	/** slots_full：同一台 Agent 上别的项目的任务占着多少个槽位（只有个数，不给场景、运行和节点）；其余状态为 0。 */
	other_project_holders: number;
}

/**
 * 在等这台 Agent 的任务：Agent 不在线、还在准备环境，或没有空闲槽位。
 * 超过 queue_expires_at 仍没有派发时任务以 env_error 失败（docs/SEMANTICS.md 的 queue_timeout）。
 */
export interface QueuedTaskView {
	task_id: string;
	run_id: string;
	orchestration_id: string;
	/** 场景现在的名称（名称不跟版本走）。 */
	orchestration_name: string;
	node_id: string;
	/** 运行绑定的场景版本里这个节点的显示名称（子流程入口节点是子流程名称）；没有时不给。 */
	display_name?: string;
	/** 节点类型，写作「包名/节点类型名」。 */
	node_type: string;
	/** 任务所在的链实例（运行监控里的链）。 */
	chain_instance_id: string;
	/**
	 * 子流程名称（与运行视图里链实例的 name 相同：没有名称字段的旧版本为子流程入口的节点 ID，名称为空时为空字符串），
	 * 取自运行绑定的场景版本；任务在主链上为 null。
	 */
	chain_name: string | null;
	attempt: number;
	/** 进入排队的时间；重试的尝试从重新排队时算。 */
	queued_at: Timestamp;
	/** 排队超时的时间；没有设置排队超时的任务为 null。 */
	queue_expires_at: Timestamp | null;
}

/**
 * 助手此刻能不能用：`ready` 为 true 当且仅当 `problems` 为空，否则列出全部原因。`workbench` 是配置的工作台（Agent 的名字），
 * 没有设置时为 null：页面据此写「可以用 · 工作台 X 在线」，工作台不在线时也能写出是哪一台。
 */
export interface Readiness {
	ready: boolean;
	problems: ReadinessProblem[];
	workbench: string | null;
}

/** 助手此刻不能用的一个原因：种类加一句给人看的话。 */
export interface ReadinessProblem {
	kind: ReadinessProblemKind;
	message: string;
}

/**
 * 助手此刻不能用的原因的种类（`Readiness`）：`assistant_not_configured` 控制面没有配置助手服务，
 * `assistant_unreachable` 助手服务连不上，`workbench_not_set` 项目没有设置工作台，`workbench_offline` 工作台的
 * Agent 不在线，`model_not_configured` 助手容器里没有配置模型，`model_unreachable` 模型连不上。
 * 产生：`assistant_*` 和 `workbench_*` 四种 #541（`workbench_*` 从 #549 起按项目的工作台登记判断），模型的两种 #548。
 */
export type ReadinessProblemKind = "assistant_not_configured" | "assistant_unreachable" | "workbench_not_set" | "workbench_offline" | "model_not_configured" | "model_unreachable";

/** 场景引用的 Agent；unknown：还没有注册过（从没连接过控制面）。 */
export interface ReferencedAgent {
	name: string;
	/** 场景的默认 Agent。 */
	default: boolean;
	status: "online" | "offline" | "unknown";
}

/** 删一个节点，连同它的连线；它恰好一进一出时前后接上（和画布上删除一样），注释框里的成员一起去掉。入口节点不能删。 */
export interface RemoveNodeOperation {
	op: "remove_node";
	node: string;
}

/**
 * 已移除种类的节点（ADR 0028，种类见 removed-nodes.ts）：读取历史版本时认得它，只读显示，不能保存。
 * 只描述所有节点共有的字段；控制面读库时把它当时的其余配置原样带着（`keepRemovedNodeConfig`），
 * 想把旧配置换成别的写法的人读得到。它不在可以保存的节点里（`OrchestrationNode`）：
 * 保存带它的文档被拒绝，从画布上删掉之后才能保存。
 */
export interface RemovedNode {
	id: string;
	kind: "feishu_notify" | "timer" | "sleep";
	position?: {
		x: number;
		y: number;
	};
	note?: string;
	display_name?: string;
}

/**
 * 最低 Agent 版本要求（ADR 0019）：格式与 `RequiresSdk` 相同，例如 `>=0.2.0`。用到 Agent 能力的节点包声明它，
 * 触发前和派发前对节点所在的 Agent 和它通过「Agent」类型的输入引用的 Agent 都检查。
 */
export type RequiresAgent = string;

export type RequiresSdk = string;

export interface RunFocus {
	/** 控制面生成这份读数的时间；页面上的「多久前」按它算。 */
	generated_at: Timestamp;
	/** 场景设了关注项是 `focus`；没设时是准备中、执行中节点的主指标 `primary`。 */
	mode: "focus" | "primary";
	/** 这次运行的指标已过保留期：每一项都没有数据。 */
	expired: boolean;
	/**
	 * 有异常（`anomaly` 不为 null）的项在前，其余在后；两部分里各自按作者设定的顺序（`position` 升序），没设关注项时
	 * 按准备中、执行中节点在运行里的顺序。
	 */
	items: RunFocusItem[];
}

/**
 * 一个关注项（或没设关注项时一个准备中、执行中节点的主指标）的读数。
 *
 * `mode` 为 `primary` 时没有图表：`chart` 与 `title` 是主指标名，`chart_type` 是 `stat`，`position` 按节点在运行里的顺序编号。
 * `unavailable` 为 `chart_missing`（这次运行锁定的节点包版本里没有这张图表）时，`chart_type` 是 `line`、`unit` 是空串、
 * 没有数据，这几个值没有意义，页面按 `unavailable` 写明原因。
 * 节点还没有开始执行（待执行、排队中、准备中、已跳过，以及没开始就失败、已取消、已停止的；所在的子流程还没触发的节点是待执行）时 `source.started_at` 为 null，
 * 没有数据，`source.status` 是节点当时的状态。
 */
export interface RunFocusItem {
	/** 作者设定的位置，从 1 开始；列表里不在这次运行里的项也占位置，所以返回的位置可以不连续。 */
	position: number;
	node_id: string;
	/** 来源节点的显示名称，取自这次运行绑定的场景版本；没有显示名称时不给。界面上写成「显示名称（节点 ID）」。 */
	display_name?: string;
	/** 图表标题。 */
	chart: string;
	/** 显示名：作者起的名字，没起名时是图表标题。 */
	title: string;
	chart_type: "line" | "area" | "bar" | "stat";
	/** 图表第一个指标的单位。 */
	unit: string;
	unavailable?: "chart_missing";
	/** 这一项读的指标，按图表里的顺序（数值卡只有第一个）；`unavailable` 时为空。 */
	metrics: FocusMetric[];
	source: FocusSource;
	latest: FocusLatest | null;
	/** 数值卡只有第一个序列，其余图表是声明的全部序列；`points` 为 0 时为空。 */
	series: FocusSeries[];
	/** 每个桶的跨度（秒，至少 1）。 */
	bucket_seconds: number;
	/** 最后一个点的控制面时间；一个点都没有为 null。 */
	last_at: Timestamp | null;
	/**
	 * 估算的采样间隔（毫秒）：最近更新的那个序列最近 10 个点之间间隔的中位数。点的时间按秒取整，同一个序列一秒最多
	 * 一个点，所以至少是 1000；点不够两个时为 null。
	 */
	sample_interval_ms: number | null;
	/**
	 * 从何时起没有新数据（控制面时间）：来源节点准备中或执行中、距离最后一个点超过 `stale` 的期限时是最后一个点的时间，一个点都
	 * 没有时是这次尝试开始执行的时间；否则（还有新数据、还没开始执行、已结束、`unavailable`）为 null。规则与异常 `stale` 相同，
	 * 但和这一项报哪一种异常无关：`anomaly` 只报一种（例如先有 WARN 再不上报时报 `log`），图表的斜线和「已 2m 10s 无新数据」看这里。
	 */
	stale_since: Timestamp | null;
	/** 来源节点成功、已停止或已取消；没开始就被停止或取消的节点也是 true，页面看 `source.started_at` 和 `latest` 才知道有没有值。 */
	final: boolean;
	anomaly: FocusAnomaly | null;
}

export interface RunFocusQuery {
	/** 每个序列降采样成多少个点；0 只要最新值，不返回序列。 */
	points?: number;
}

/** 进行中的节点（排队中、准备中、执行中、等待中），按链与链上的顺序。 */
export interface RunListActiveNode {
	chain_instance_id: string;
	node_id: string;
	/** 节点的显示名称（子流程入口节点是子流程名称），取自运行绑定的场景版本；没有时不给。 */
	display_name?: string;
	status: string;
	/** 最后一次尝试的尝试号（从 1 开始）。 */
	attempt: number;
	/** 任务所在的 Agent（排队中的任务是它在等的 Agent）；不在 Agent 上执行的节点（停止子流程节点）为 null。 */
	agent: string | null;
	/** 最后一次尝试开始的时间；还没开始执行（排队中、准备中）时为 null。 */
	started_at: Timestamp | null;
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
	/**
	 * 子流程名称（与运行视图里链实例的 name 相同：没有名称字段的旧版本为子流程入口的节点 ID，名称为空时为空字符串），
	 * 取自运行绑定的场景版本；主链不给。
	 */
	subflow_name?: string;
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
	/**
	 * 子流程名称（与运行视图里链实例的 name 相同：没有名称字段的旧版本为子流程入口的节点 ID，名称为空时为空字符串），
	 * 取自运行绑定的场景版本；主链不给。
	 */
	subflow_name?: string;
	/** 链上第一个失败的节点（按失败的先后，GLOSSARY「第一个失败的节点」）；没有失败节点时（例如参数校验失败）为 null。 */
	node_id: string | null;
	/** 失败节点的显示名称（子流程入口节点是子流程名称），取自运行绑定的场景版本；没有时不给。 */
	display_name?: string;
}

export interface RunListItem {
	id: string;
	orchestration_id: string;
	orchestration_name: string;
	orchestration_version: number;
	status: "running" | "success" | "failed" | "cancelled";
	/** 已请求取消、正在清理（运行状态仍是 running）。 */
	cancelling: boolean;
	/** 触发人的昵称。 */
	triggered_by: string;
	/** 经哪个 AI 编程助手触发；没有时为 null。 */
	triggered_via: string | null;
	/** 触发时选用的运行预设；没有用预设时为 null。 */
	preset: RunListPreset | null;
	started_at: Timestamp;
	ended_at: Timestamp | null;
	/** 按深度、开始时间排序。 */
	chains: RunListChain[];
	active_nodes: RunListActiveNode[];
	/**
	 * 失败的链实例，按失败的先后：有失败节点的链按它第一个失败的节点的结束时间（同一时刻按链的顺序），所以第一项是这次运行
	 * 「第一个失败的节点」所在的链（和控制台、运行监控、运行通知是同一个节点）；链失败却没有失败节点的排在最后。
	 */
	failures: RunListFailure[];
}

/** 运行列表里一个运行用的运行预设：只有 ID 和触发时的名称（列表不带预设参数的名单）。 */
export interface RunListPreset {
	/** 预设的 ID；预设可能已被删除。 */
	id: string;
	/** 触发时预设的名称。 */
	name: string;
}

export interface RunListQuery {
	/** 只要这个状态的运行。 */
	status?: "running" | "success" | "failed" | "cancelled";
	/** 只要这个场景的运行。 */
	orchestration_id?: string;
	/** 运行编号前缀或触发人（包含，不区分大小写）。 */
	q?: string;
	/** 只要这个触发人的运行：昵称整个相等（区分大小写）。`q` 会把昵称里的文字也当关键字，要精确找一个人的运行用它。 */
	triggered_by?: string;
	/** 只要运行编号以它开头的运行（不分大小写，只能写十六进制数字和 `-`）。`q` 还会按触发人匹配，只想按编号找时用它。 */
	id_prefix?: string;
	/** 最多返回多少个运行（默认 200，最多 500），按开始时间从新到旧。 */
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
	/** 一页最多多少行（默认 200）。 */
	limit?: number;
	/** 只看这些节点的日志，写法 `链路实例 ID:节点 ID,节点 ID;…`；不给是全部节点，给空字符串是没有节点。 */
	nodes?: RunLogNodesParam;
	/** 只要这些级别的日志，逗号分隔（例如 `warn,error`）；不给是全部级别。 */
	level?: string;
}

/**
 * 按运行读取日志的范围参数：分页、实时推送（#225）、下载（#226）共用。
 * 不给 `nodes` 是全部节点；给了空字符串是没有节点（写法与判断函数见 run-log-scope.ts）。
 */
export interface RunLogScopeQuery {
	/** 只看这些节点的日志，写法 `链路实例 ID:节点 ID,节点 ID;…`；不给是全部节点，给空字符串是没有节点。 */
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
	/** 发给哪个飞书机器人（名称）；null 关闭运行通知。 */
	bot?: FeishuBotName | null;
	/** 什么情况下发：failed 仅失败，failed_or_cancelled 失败和取消。`always` 已去掉：成功的运行不再发运行通知。 */
	trigger?: RunNotificationTrigger;
	/** 卡片标题；空字符串用场景名。 */
	title?: string;
	/** 附加说明（Markdown，可以 @ 人），放在卡片正文的最前面；空字符串即没有。 */
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

/**
 * 运行通知的触发条件（GLOSSARY「运行通知」）：仅失败、失败和取消。运行通知是兜底，成功的运行不发；不想发就把机器人设成
 * null。曾经有的「总是」（`always`，成功、失败、取消都发）已经去掉（#446）：升级时存量的「总是」改成了失败和取消，
 * 保存设置时再写它会被拒绝（`runNotificationTriggerRemovedMessage`）。
 */
export type RunNotificationTrigger = "failed" | "failed_or_cancelled";

/** 运行用的运行预设，记的是触发时的情况：预设之后改名、删除都不影响。 */
export interface RunPresetView {
	/** 预设的 ID；预设可能已被删除。 */
	id: string;
	/** 触发时预设的名称。 */
	name: string;
	/** 预设参数的名单：这些参数的值来自预设。 */
	params: string[];
}

/**
 * 运行摘要（类型名叫 RunReport：`RunSummary` 已经是运行列表里的一项）：运行状态（`RunState`）加上只有接口给得起的内容。`self` 总是 null，`truncated` 总是 false，
 * 错误信息不截断。
 */
export interface RunReport {
	run_id: string;
	scenario: {
		id: string;
		/** 场景此刻的名称（名称不跟版本走）。 */
		name: string;
		/** 运行绑定的场景版本号。 */
		version: number;
	};
	/**
	 * 运行此刻的状态。运行还没结束时是 `running`：引用它的节点自己还没结束，所以节点里看到的总是 `running`，
	 * 不能用它判断结果，看 `result_so_far`。
	 */
	status: RunStatus;
	/**
	 * 按运行结果的规则对「到此刻为止」算出的结果：已请求取消是 `cancelled`，否则有节点（或链）最终失败是 `failed`，
	 * 否则是 `success`；运行结束时的最终状态只会比它更坏（运行已经结束时它就是 `status`）。
	 */
	result_so_far: "success" | "failed" | "cancelled";
	/** 触发人的昵称。 */
	triggered_by: string;
	/** 经哪个 AI 编程助手触发；没有时为 null。 */
	triggered_via: string | null;
	started_at: Timestamp;
	ended_at: Timestamp | null;
	/** 取消请求；没有被请求取消时为 null。`forced_at`：清理期间再次取消（强制取消）的时间。 */
	cancel: {
		requested_by: string;
		/** 经哪个 AI 编程助手取消；没有时为 null。 */
		requested_via: string | null;
		requested_at: Timestamp;
		forced_at: Timestamp | null;
	} | null;
	/**
	 * 最终失败的节点的 ID，按失败的先后（和控制台、运行记录、运行通知同一份顺序，GLOSSARY「第一个失败的节点」）：
	 * 第一项就是第一个失败的节点。一次运行里节点 ID 不重复，用它去链实例的 `nodes` 里找。
	 */
	failures: string[];
	/** 节点拿到这份状态时，引用它的那个节点；运行摘要接口里为 null。 */
	self: {
		chain_instance_id: string;
		node_id: string;
	} | null;
	/**
	 * 整份状态超过大小上限时，从 `failures` 的末尾开始去掉 `error.message`（那几个节点的 `message_truncated` 为 true），
	 * 直到放得下；去掉过时为 true。
	 */
	truncated: boolean;
	/** 运行里已经创建的全部链实例，按层数、开始时间排序；还没被触发的子流程不在里面，看触发它的异步任务节点的状态。 */
	chains: RunStateChain[];
	/** 耗时（毫秒，控制面时间）；运行还没结束时为 null。 */
	duration_ms: number | null;
	/**
	 * 失败的任务（节点最终失败的，和重试之后成功的节点上失败的那几次），按链实例的顺序、节点在链上的顺序、尝试的序号，
	 * 最多 `RUN_REPORT_LIMITS.failedTasks` 个；完整的错误信息和日志尾部在这里，`chains` 里的节点只有最近一次尝试的错误。
	 * 最终失败的节点按失败的先后看 `failures`。
	 */
	failed_tasks: RunReportFailedTask[];
	/** 失败的任务的总数（超过上限时比 `failed_tasks` 的个数大，其余的看 `sfly run show`、`sfly run logs --failed`）。 */
	failed_tasks_total: number;
	/**
	 * 失败的动作，最近结束的在前，最多 `RUN_REPORT_LIMITS.failedActions` 个：取每个任务动作摘要里最近失败的那几个
	 * （任务的动作摘要最多留 5 个），所以一个任务失败得很多时只看到最近的。
	 */
	failed_actions: RunReportFailedAction[];
	/**
	 * 有异常的关注项（场景设了关注项时才有；没设时为空，不用执行中节点的主指标代替），按作者设定的顺序。
	 * 摘要只给最新值，要曲线用 `GET /runs/:id/focus`。
	 */
	attention_items: RunReportAttentionItem[];
}

/** 有异常的关注项：关注项读数（`GET /runs/:id/focus`）里的一项，只留下认出它是哪一项、最新值和异常的字段。 */
export interface RunReportAttentionItem {
	/** 作者设定的位置，从 1 开始；列表里不在这次运行里的项也占位置，所以返回的位置可以不连续。 */
	position: number;
	node_id: string;
	/** 来源节点的显示名称，取自这次运行绑定的场景版本；没有显示名称时不给。界面上写成「显示名称（节点 ID）」。 */
	display_name?: string;
	/** 图表标题。 */
	chart: string;
	/** 显示名：作者起的名字，没起名时是图表标题。 */
	title: string;
	/** 图表第一个指标的单位。 */
	unit: string;
	source: FocusSource;
	latest: FocusLatest | null;
	/** 异常的原因（规则见 `FocusAnomalyKind`）。 */
	anomaly: FocusAnomaly;
}

/** 一个失败的动作，带上它所在的节点和尝试。 */
export interface RunReportFailedAction {
	/** 任务内的动作 ID（动作和标记共用一个序列），先后不一定是开始的先后。 */
	id: number;
	/** 父动作的 ID；最外层为 null。父动作不一定还在摘要里。 */
	parent: number | null;
	/** 层级：最外层是 0。 */
	depth: number;
	name: string;
	/** 说明字段（值都是文字），开始时给的加上之后补充的。 */
	fields: Record<string, string>;
	/** 开始的控制面时间。 */
	started_at: Timestamp;
	/** 开始的 Agent 时间。 */
	agent_started_at: Timestamp;
	ended_at: Timestamp;
	agent_ended_at: Timestamp;
	/** 耗时（毫秒），按单调时钟算，不受 Agent 系统时间改动的影响。 */
	duration_ms: number;
	result: ActionResult;
	/** 失败的原因（最多 `ACTION_LIMITS.reasonChars` 个字符）；其他结果为 null。 */
	reason: string | null;
	chain_instance_id: string;
	node_id: string;
	/** 节点的显示名称；没有时为 null。 */
	display_name: string | null;
	attempt: number;
	task_id: string;
}

/**
 * 一个失败的任务：节点的一次失败的尝试。重试过的节点每次失败的尝试各一项（重试之后成功的节点，失败的那几次也算）；
 * 节点失败了、却没有失败的尝试（还没开始执行就失败）时，是它最后一次尝试，没有尝试时 `attempt` 和 `task_id` 为 null。
 */
export interface RunReportFailedTask {
	chain_instance_id: string;
	/** 链的子流程名称（名称为空时是空字符串）；主链为 null。 */
	chain: string | null;
	node_id: string;
	/** 节点的显示名称；没有时为 null。 */
	display_name: string | null;
	/** 节点的种类（场景文档里节点的 `kind`）。 */
	kind: string;
	/** 节点类型：包节点是「包名/节点名」，其他种类的节点为 null（用 `kind`）。 */
	node_type: string | null;
	/** 这次尝试的序号；没有尝试时为 null。 */
	attempt: number | null;
	/** 这个节点总共尝试了几次。 */
	attempts: number;
	task_id: string | null;
	/** 这次尝试的错误；没有错误信息时为 null。 */
	error: {
		kind: string;
		/** 失败原因的一行（同 `RunStateError` 的 `headline`）。 */
		headline: string;
		/** 完整的错误信息：异常信息加堆栈，原文（已按保密参数的值打码）。 */
		detail: string;
		/** 节点代码里出错的位置，同 `RunStateError` 的 `location`；没有时为 null。 */
		location: string | null;
	} | null;
	/** 日志尾部；没有任务（`task_id` 为 null）时为 null。 */
	logs: RunReportLogTail | null;
}

/** 一个失败的任务（节点的一次失败的尝试）的日志尾部。 */
export interface RunReportLogTail {
	/** 最后的若干行（行数有上限，`RUN_REPORT_LIMITS.logLines`），按时间从早到晚。 */
	lines: LogLineView[];
	/** 前面还有更早的日志（用 `GET /tasks/:id/logs` 往前翻）。 */
	earlier: boolean;
	/** 运行已超过保留期，日志已被清理（此时 `lines` 为空）。 */
	expired: boolean;
	/**
	 * 日志读不到：控制面记着这个任务写过日志，日志文件里却读不出行（文件不在了、被移走了，运行还没过保留期）。
	 * 此时 `lines` 为空，但不是这个任务没有日志（没写过日志的任务 `lines` 也为空，`missing` 为 false）。
	 */
	missing: boolean;
}

/** 一个链实例：主链，或由异步任务节点触发的子流程实例。 */
export interface RunStateChain {
	id: string;
	/** 链起点节点 ID（主链是入口节点，子流程是子流程入口节点）。 */
	chain_id: string;
	/** 子流程名称（名称为空时是空字符串）；主链为 null。 */
	name: string | null;
	/** 层数：主链是 0，主链触发的子流程是 1。 */
	depth: number;
	/** 触发它的异步任务节点所在的链实例；主链为 null。 */
	parent_chain_instance_id: string | null;
	/** 触发它的异步任务节点；主链为 null。异步任务节点成功只表示子流程实例已创建，子流程的结果看这个链实例自己的 `status`。 */
	async_node_id: string | null;
	status: RunStatus;
	started_at: Timestamp;
	ended_at: Timestamp | null;
	/** 这条链上的全部节点，按链上的顺序。 */
	nodes: RunStateNode[];
}

/** 一个失败节点的错误（最近一次尝试的）。错误信息按这次运行的保密参数的值打码，和运行视图里看到的一样。 */
export interface RunStateError {
	/** 错误类型：node_error（节点代码抛出异常）、timeout、agent_lost、env_error、config_error。 */
	kind: string;
	/**
	 * 失败原因的一行（和运行监控页头同一个取法，`errorHeadline`）：错误信息里第一行有内容的文字，去掉行首的异常模块路径；
	 * 没有错误信息时是空串。
	 */
	headline: string;
	/**
	 * 异常信息本身，不含堆栈（执行器的失败结果里它们本来是分开的，两部分拼在一起存下以后用 `splitErrorText` 拆开）。
	 * 超过长度上限时截到上限、末尾是「…」，`message_truncated` 为 true。
	 */
	message: string;
	/** `message` 被截断（超过长度上限，或整份状态超过大小上限被去掉）了。 */
	message_truncated: boolean;
	/**
	 * 节点代码里出错的位置（一行文字，格式和任务被终止时的那一行相同：`模块.函数 第 N 行`）；没有时为 null。
	 * 位置由执行器算出、存在任务上（#471）；超时、Agent 失联、旧版本上报的和升级之前的任务没有位置，为 null。
	 */
	location: string | null;
}

/** 一个链实例上的一个节点。 */
export interface RunStateNode {
	node_id: string;
	/** 节点的显示名称（子流程入口节点是子流程名称），取自运行绑定的场景版本；没有时为 null。 */
	display_name: string | null;
	/**
	 * 节点的种类，场景文档里节点的 `kind`（`package`、`entry`、`subflow_entry`、`async`、`stop_subflow`……）；
	 * 场景里已移除种类的节点原样给出它的 `kind`，读它的一方遇到不认识的取值当作「别的种类」。
	 */
	kind: string;
	/**
	 * 最近一次尝试的状态（取值同运行视图里的节点状态）；还没有尝试时为 `pending`，被跳过时为 `skipped`，没开始就被取消时为
	 * `cancelled`（这两种都没有尝试）。
	 */
	status: NodeStatus;
	/** 尝试次数，口径和运行视图相同（不含被跳过、没开始就被取消或停止的占位）。 */
	attempts: number;
	/**
	 * 最近一次尝试开始执行、结束的时间（控制面时间）；还没开始、还没结束时为 null。没开始就被取消或停止的节点（含重试在排队时被
	 * 取消或停止的）：`started_at` 为 null，`ended_at` 是取消或停止的时间，不是上一次尝试的时间。
	 */
	started_at: Timestamp | null;
	ended_at: Timestamp | null;
	/** 只在 `status` 是 `failed` 时有：最近一次尝试的错误。被取消、被停止、被跳过的节点没有；超时的节点是 `failed`、`kind` 是 `timeout`。 */
	error: RunStateError | null;
}

export type RunStatus = "running" | "success" | "failed" | "cancelled";

/** 运行列表里的一项。 */
export interface RunSummary {
	id: string;
	orchestration_id: string;
	orchestration_version: number;
	status: RunStatus;
	/** 触发人的昵称。 */
	triggered_by: string;
	/** 经哪个 AI 编程助手触发（请求头 `x-sfly-client` 里的 `agent/<名称>`）；没有时为 null。只是标注，不是鉴权。 */
	triggered_via: string | null;
	started_at: Timestamp;
	ended_at: Timestamp | null;
	/** 触发时选用的运行预设；没有用预设时为 null。 */
	preset: RunListPreset | null;
	/** 已请求取消、还在等待任务结束与清理（status 仍是 running，界面显示「取消中」）。 */
	cancelling: boolean;
}

export interface RunView {
	id: string;
	orchestration_id: string;
	orchestration_version: number;
	status: RunStatus;
	/** 触发人的昵称。 */
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

/** 一个正在做的动作。 */
export interface RunningActionView {
	/** 任务内的动作 ID（动作和标记共用一个序列），先后不一定是开始的先后。 */
	id: number;
	/** 父动作的 ID；最外层为 null。父动作不一定还在摘要里。 */
	parent: number | null;
	/** 层级：最外层是 0。 */
	depth: number;
	name: string;
	/** 说明字段（值都是文字），开始时给的加上之后补充的。 */
	fields: Record<string, string>;
	/** 开始的控制面时间。 */
	started_at: Timestamp;
	/** 开始的 Agent 时间。 */
	agent_started_at: Timestamp;
}

/** 派发给 Agent、还没结束的任务（占着槽位）。 */
export interface RunningTaskView {
	task_id: string;
	run_id: string;
	orchestration_id: string;
	/** 场景现在的名称（名称不跟版本走）。 */
	orchestration_name: string;
	node_id: string;
	/** 运行绑定的场景版本里这个节点的显示名称（子流程入口节点是子流程名称）；没有时不给。 */
	display_name?: string;
	/** 节点类型，写作「包名/节点类型名」。 */
	node_type: string;
	/** 任务所在的链实例（运行监控里的链）。 */
	chain_instance_id: string;
	/**
	 * 子流程名称（与运行视图里链实例的 name 相同：没有名称字段的旧版本为子流程入口的节点 ID，名称为空时为空字符串），
	 * 取自运行绑定的场景版本；任务在主链上为 null。
	 */
	chain_name: string | null;
	attempt: number;
	/** dispatched：下载、安装、启动中；running：执行器已启动。 */
	status: "dispatched" | "running";
	/** 执行器启动的时间；准备中为 null。 */
	started_at: Timestamp | null;
	/** 此刻在做的动作（见 CurrentAction）；没有时为 null，准备中也为 null。 */
	current_action: CurrentAction | null;
	/** 最新进度（ctx.progress）；没上报过时为 null。说明里的 secret 值按写入时这次运行已知的 secret 打码；运行视图读取时还会按当时的 secret 再打一遍，所以写入之后才出现的 secret 值，运行视图会打码、这里不会。 */
	progress: TaskProgressView | null;
}

/** 助手正在跑的一次工具调用，和它已经输出的最后一段（至多 `runningToolOutputBytes`）。 */
export interface RunningTool {
	call_id: string;
	tool: SessionTool;
	title: string;
	output: string;
}

export interface SavedVersionView {
	id: string;
	orchestration_id: string;
	number: number;
	/** 保存这个版本的人的昵称。 */
	author: string;
	author_via: string | null;
	created_at: Timestamp;
	document: StoredOrchestrationDocument;
	/** 保存时的静态检查警告：只提示，不阻止保存。 */
	warnings: DocumentWarningView[];
}

/** `POST /sessions/:id/messages`：对会话说一句话（空闲时开始新的一轮，在做时是插话）。 */
export interface SendMessageBody {
	text: SessionMessageText;
}

/** 发话的结果：这句话的 `user_message` 的序号。 */
export interface SendMessageResult {
	seq: number;
}

/** `GET /sessions/:id` 的 query：`before` 是序号，取比它小的事件（往前翻页）。 */
export interface SessionDetailQuery {
	before?: number;
}

/**
 * `GET /sessions/:id`：会话，和最多 `SESSION_HISTORY_PAGE` 条持久事件（序号升序，没有 `before` 时是最新的
 * 一页）；`has_more` 为 true 表示更早的还有。
 */
export interface SessionDetailResponse {
	id: SessionId;
	title: string;
	status: SessionStatus;
	created_by: string;
	created_at: Timestamp;
	/** 最近一次活动（新建、发话、事件落库）的时间。 */
	last_activity_at: Timestamp;
	queue_position: number | null;
	last_turn_outcome: TurnOutcome | null;
	project: string;
	readiness: Readiness;
	waiting_for: WaitingFor | null;
	events: PersistedSessionEvent[];
	has_more: boolean;
}

/**
 * `GET /sessions/:id/events` 的 query：`after` 是序号，从它之后的持久事件开始推（浏览器重连也可以带 `Last-Event-ID`，
 * 它不是整数或超过 `SESSION_SEQ_MAX` 的当作没带）。
 */
export interface SessionEventsQuery {
	after?: number;
}

/** 会话 ID：UUID。助手服务拿它给 pi 的会话文件命名，所以协议里就限定成 UUID，不会带出路径。 */
export type SessionId = string;

/**
 * 会话列表里的一项。`created_by` 是发起人的昵称；`queue_position` 只在排队中（`status` 为 `queued`）时有值，
 * 从 1 起；`last_turn_outcome` 是上一轮的结局，还没有结束过的一轮时为 null。
 */
export interface SessionListItem {
	id: SessionId;
	title: string;
	status: SessionStatus;
	created_by: string;
	created_at: Timestamp;
	/** 最近一次活动（新建、发话、事件落库）的时间。 */
	last_activity_at: Timestamp;
	queue_position: number | null;
	last_turn_outcome: TurnOutcome | null;
}

/**
 * `GET /projects/:project/sessions`：助手此刻能不能用，和项目里的会话：在做和排队中的在前，其余按最近活动倒序
 * （#551 的写法；#544 之前没有排队，在做的至多一个），最多 `SESSION_LIST_LIMIT` 个。
 */
export interface SessionListResponse {
	readiness: Readiness;
	sessions: SessionListItem[];
	/** 会话超过 `SESSION_LIST_LIMIT` 个，更早的没有列出来（页面据此提示）。 */
	truncated: boolean;
}

/** 会话里的一句话：新建会话的第一句、发话、插话。非空（不能只有空白），不超过 `SESSION_MESSAGE_MAX_CHARS` 个字符。 */
export type SessionMessageText = string;

/**
 * 会话的状态：`idle` 空闲、`running` 在做（有一轮在进行）、`queued` 排队中（同一个项目另一个会话在做，#544）、
 * `ended` 已结束。
 */
export type SessionStatus = "idle" | "running" | "queued" | "ended";

/**
 * 助手能用的工具：读、写、编辑文件，执行命令（`command`）。文件和命令都落在工作台上。取值是平台的叫法，不是 pi 的工具名：
 * 换 pi 或换嵌入方式时它不跟着变（助手服务把 pi 的工具名翻成它们）。
 */
export type SessionTool = "read" | "write" | "edit" | "command";

/**
 * 一个会话：列表项的字段，加它所在的项目（标识）、此刻的就绪状态，和排队中在等谁（`waiting_for`，不在排队时为 null；
 * `turn_queued` 不持久，刷新页面后靠它拿回在等谁，#544）。
 */
export interface SessionView {
	id: SessionId;
	title: string;
	status: SessionStatus;
	created_by: string;
	created_at: Timestamp;
	/** 最近一次活动（新建、发话、事件落库）的时间。 */
	last_activity_at: Timestamp;
	queue_position: number | null;
	last_turn_outcome: TurnOutcome | null;
	project: string;
	readiness: Readiness;
	waiting_for: WaitingFor | null;
}

/**
 * 改一个节点的一个字段：`field` 是 SETTABLE_NODE_FIELDS 之一或 `inputs.<输入名>`；`value` 不写就是去掉这个字段，
 * 去掉的字段按没有写处理（`always` 为 false、Agent 用场景的默认 Agent）；写 null 就是 null（输入可以是 null）。
 */
export interface SetFieldOperation {
	op: "set";
	node: string;
	field: string;
	value?: unknown;
}

/** 占着槽位的任务：哪个场景的哪个运行里哪个节点的第几次尝试（排队的尝试在等的槽位被它们占着）。 */
export interface SlotHolderView {
	run_id: string;
	orchestration_id: string;
	/** 场景现在的名称（名称不跟版本走）。 */
	orchestration_name: string;
	node_id: string;
	/** 运行绑定的场景版本里这个节点的显示名称（子流程入口节点是子流程名称）；没有时不给。 */
	display_name?: string;
	/** 子流程名称（没有名称的旧版本为子流程入口的节点 ID，名称为空时为空字符串）；任务在主链上为 null。 */
	chain_name: string | null;
	attempt: number;
	/** dispatched：下载、安装、启动中；running：执行器已启动。 */
	status: "dispatched" | "running";
	/** 执行器启动的时间；准备中为 null。 */
	started_at: Timestamp | null;
}

/**
 * 会话此刻的状态：控制面在浏览器刚连上事件流时，只发给这一条连接，让断线期间错过的增量不用补发
 * （`partial_text` 是正在输出的那条助手消息已有的文字，没有时为空字符串；`running_tool` 没有在跑的工具时为 null；
 * `steer_queue` 是还没送到模型的插话；`waiting_for` 是排队中在等谁，不在排队时为 null）。不存。#545 起（`waiting_for` #544）。
 */
export interface SnapshotEvent {
	type: "snapshot";
	status: SessionStatus;
	partial_text: string;
	running_tool: RunningTool | null;
	steer_queue: SteerEntry[];
	waiting_for: WaitingFor | null;
}

/** 插话队列里的一条：用户这句话的 ID（`user_message.message_id`）和文字。 */
export interface SteerEntry {
	message_id: string;
	text: string;
}

/**
 * 还没送到模型的插话，完整列表（每次变化都发一条，取代上一条）：每条带自己的 `message_id`，不靠文字对应。
 * 助手服务产生，对应 pi 的 `queue_update` 的 `steering`。不存。#544 起。
 */
export interface SteerQueueEvent {
	type: "steer_queue";
	messages: SteerEntry[];
}

export interface StopSubflowNode {
	id: string;
	/** 布局属于版本内容。 */
	position?: {
		x: number;
		y: number;
	};
	/** 备注：多行说明，写这个节点做什么、为什么这样配置。属于版本内容，只用于显示，不影响执行（docs/SEMANTICS.md §1.5）。 */
	note?: string;
	display_name?: string;
	kind: "stop_subflow";
	always: boolean;
	/**
	 * 要停止的子流程：子流程入口的节点 ID（画布里按名称选择，改名不影响引用，docs/SEMANTICS.md §4.1）。
	 * 可选：画布新建的节点还没有选择；没有选择时保存只警告、触发时拒绝（docs/SEMANTICS.md §1.2）。
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
	/** 备注：多行说明，写这个节点做什么、为什么这样配置。属于版本内容，只用于显示，不影响执行（docs/SEMANTICS.md §1.5）。 */
	note?: string;
	display_name?: string;
	kind: "stop_subflow";
	always?: boolean;
	/**
	 * 要停止的子流程：子流程入口的节点 ID（画布里按名称选择，改名不影响引用，docs/SEMANTICS.md §4.1）。
	 * 可选：画布新建的节点还没有选择；没有选择时保存只警告、触发时拒绝（docs/SEMANTICS.md §1.2）。
	 */
	subflow?: string;
}

/** 读到的节点：可以执行、可以保存的种类，加上已移除种类的占位。 */
export type StoredNode = OrchestrationNode | RemovedNode;

/**
 * 读到的场景文档（接口的响应、控制面读库、画布打开最新版本）：结构和保存用的 `OrchestrationDocument` 相同，
 * 只是节点里可以有已移除种类的占位（`RemovedNode`）。场景版本不可变，历史版本里留着已移除的节点，读取时认得它们。
 * 保存不接受这些占位：把读到的文档原样传回保存之前，先过滤掉 `RemovedNode`。
 */
export interface StoredOrchestrationDocument {
	default_agent?: string;
	nodes: StoredNode[];
	edges: Edge[];
	/** 锁定的节点包版本：包名 → 版本（`dev` 表示开发版本）。 */
	packages: Record<PackageName, string>;
	annotations: Annotation[];
}

export interface SubflowEntryNode {
	id: string;
	/** 布局属于版本内容。 */
	position?: {
		x: number;
		y: number;
	};
	/** 备注：多行说明，写这个节点做什么、为什么这样配置。属于版本内容，只用于显示，不影响执行（docs/SEMANTICS.md §1.5）。 */
	note?: string;
	kind: "subflow_entry";
	/**
	 * 子流程的名称，场景内唯一（停止子流程节点按名称选择子流程，docs/SEMANTICS.md §4.1）。
	 * 可选只为兼容旧版本：没有该字段时以节点 ID 作为名称；为空或重复时保存只警告、触发时拒绝（docs/SEMANTICS.md §1.2）。
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
	/** 备注：多行说明，写这个节点做什么、为什么这样配置。属于版本内容，只用于显示，不影响执行（docs/SEMANTICS.md §1.5）。 */
	note?: string;
	kind: "subflow_entry";
	/**
	 * 子流程的名称，场景内唯一（停止子流程节点按名称选择子流程，docs/SEMANTICS.md §4.1）。
	 * 可选只为兼容旧版本：没有该字段时以节点 ID 作为名称；为空或重复时保存只警告、触发时拒绝（docs/SEMANTICS.md §1.2）。
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
 * dispatched（界面写「准备中」）：已派发给 Agent，还在下载、安装节点包或启动执行器；
 * waiting：停止子流程节点在等被停止的子流程结束；stopped：所在子流程被停止子流程节点停止（docs/SEMANTICS.md §4.1，不算失败）。
 */
export type TaskStatus = "queued" | "dispatched" | "running" | "waiting" | "success" | "failed" | "skipped" | "cancelled" | "stopped";

/** 模型在思考（不带思考的内容）。助手服务产生，对应 pi 的 `thinking_start`、`thinking_delta`。不存。#540 起。 */
export interface ThinkingEvent {
	type: "thinking";
}

/** 时间：ISO 8601 字符串（控制面用 `Date#toISOString()` 输出）。 */
export type Timestamp = string;

/** 一次模型调用（或一轮合计）用的 token：输入、输出、缓存读、缓存写。 */
export interface TokenUsage {
	input: number;
	output: number;
	cache_read: number;
	cache_write: number;
}

/** 工具执行中输出的增量文字（对应 pi 的 `tool_execution_update`）。助手服务产生。不存。#540 起。 */
export interface ToolOutputEvent {
	type: "tool_output";
	call_id: string;
	text: string;
}

/** 一轮到了哪一种上限（`turn_end.limit_kind`，`outcome` 为 `limit` 时给出）：`model_calls` 模型调用次数，`duration` 用时。#540 起。 */
export type TurnLimit = "model_calls" | "duration";

/**
 * 一轮（GLOSSARY「一轮」）的结局，`turn_end.outcome` 和会话的 `last_turn_outcome`：
 * - `completed` 完成：pi 报告 `agent_settled`；
 * - `stopped` 已停止：用户停止；
 * - `limit` 到了上限：一轮的模型调用次数或用时用完（哪一种见 `turn_end.limit_kind`，`TurnLimit`；默认 40 次模型调用、
 *   20 分钟，#540）；
 * - `model_unavailable` 模型不可用：模型没有配置或连不上，带 `error_class`（#640 起按下面 `ErrorClass` 的规则分）；
 * - `interrupted` 中断：pi 进程在这一轮里退出了；助手服务重启了，由控制面补一条（#545）；
 * - `failed` 其他错误。
 * 产生：助手服务从 #540 起产生全部六种；控制面也会写：补的 `interrupted`（助手服务重启了，#545）和 `failed`
 * （助手服务同时在做的会话太多，进程数满了，#545）。
 */
export type TurnOutcome = "completed" | "stopped" | "limit" | "model_unavailable" | "interrupted" | "failed";

/**
 * 这个会话在排队：同一个项目同一时刻只跑一轮，另一个会话在做。控制面产生。`position` 从 1 起，
 * `waiting_for` 是正在做的那个会话。不存：排队的状态记在会话的 `status`、`queue_position` 上，在等谁也在会话视图
 * （`SessionView`）和快照（`SnapshotEvent`）里，刷新页面后拿得回来。#544 起。
 */
export interface TurnQueuedEvent {
	type: "turn_queued";
	position: number;
	waiting_for: WaitingFor;
}

/** 检查的结果：带标记的警告，和保存之后相对最新版本的差异。保存带 `strict` 被拒绝时，错误的 details 也是它。 */
export interface VersionCheckView {
	/** 和保存时相同的警告，每条带 `existing`。 */
	warnings: CheckedWarningView[];
	/** 保存之后相对最新版本（还没有版本时是初始文档）的差异。 */
	diff: DocumentDiffView;
}

export interface VersionSummaryView {
	number: number;
	/** 保存这个版本的人的昵称。 */
	author: string;
	/** 经哪个 AI 编程助手保存（请求头 `x-sfly-client` 里的 `agent/<名称>`）；没有时为 null。只是标注，不是鉴权。 */
	author_via: string | null;
	created_at: Timestamp;
}

/** 排队的会话在等谁：正在做的那个会话，它的标题和发起人（昵称）。 */
export interface WaitingFor {
	session_id: SessionId;
	title: string;
	created_by: string;
}
