import type { ErrorKind } from "@sfly/orchestration";
// Drizzle 表定义（唯一来源）。修改后运行 `pnpm --filter @sfly/server db:generate --name <描述>` 生成迁移。
// 表随各票据加入，见 docs/ARCHITECTURE.md §6.2。
import {
	type ActionResult,
	type ActionSummaryView,
	type AgentUpdateState,
	type CurrentAction,
	type FocusItemInput,
	keepRemovedNodeConfig,
	ON_AGENT_STATUSES,
	type PackageMetadata,
	type RunNotificationTrigger,
	type SessionStatus,
	StoredOrchestrationDocument,
	withoutRemovedFields,
} from "@sfly/schema";
import { sql } from "drizzle-orm";
import {
	bigint,
	bigserial,
	boolean,
	check,
	customType,
	doublePrecision,
	foreignKey,
	index,
	integer,
	json,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import type { ProjectId } from "../projects/project-id.js";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/**
 * 场景文档（jsonb）：读出时按读到的场景文档 schema 解析，和保存时一样补上默认值。场景版本不可修改，
 * 升级前保存的版本没有后来新增的字段（例如注释框 `annotations`）；所有读文档的地方（接口返回的最新版本、
 * 历史版本、运行绑定的版本，复制、恢复，引擎）都经过这里，拿到的文档和 StoredOrchestrationDocument 的类型一致。
 * 版本里已移除种类的节点（ADR 0028）认得、原样带着配置，不报错；已移除的顶层字段（便签 `sticky_notes`，
 * 每个移除之前保存的版本都带着）先去掉再解析，读到的文档里没有它们，库里的版本不改；按更早的规则保存、
 * 现在已经解析不了的文档原样返回（历史版本照旧能看），返回的也是去掉了已移除字段的那一份。
 */
const orchestrationDocument = customType<{
	data: StoredOrchestrationDocument;
	driverData: unknown;
}>({
	dataType: () => "jsonb",
	toDriver: (document) => JSON.stringify(document),
	fromDriver: (value) => {
		const stored: unknown = withoutRemovedFields(
			typeof value === "string" ? JSON.parse(value) : value,
		);
		const parsed = StoredOrchestrationDocument.safeParse(stored);
		return parsed.success
			? keepRemovedNodeConfig(parsed.data, stored)
			: (stored as StoredOrchestrationDocument);
	},
});

/** 存下的动作摘要：SDK 写的那一份；控制面有没有兜底丢弃过明细记在任务上（`tasks.action_capped`），读取时才合进去。 */
export type StoredActionSummary = Omit<
	ActionSummaryView,
	"control_plane_capped" | AddedSummaryField
> &
	Partial<Pick<ActionSummaryView, AddedSummaryField>>;

/** 后来才有的摘要字段（#726）：之前存下的摘要没有，读出来时补上（`summaryOfTask`）。 */
type AddedSummaryField = "failed_total" | "names_complete" | "unlisted" | "lists_trimmed";

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

/**
 * Agent 连接时出示的凭据（`agents.last_auth_kind`）：`none` 不带凭据，`shared` 共享令牌，`agent` 按台签发的 Agent 凭据（#492）。
 * 后两个和 `agent_credentials.kind` 的取值一致；库里有 CHECK（`agents_last_auth_kind`）。
 */
export type AgentAuthKind = "none" | "shared" | "agent";

/**
 * Agent：按名称唯一；第一次 Hello 时注册，之后每次连接更新信息。属于一个项目（ADR 0029）；
 * 第一步名字仍然全局唯一（主键不变），第二步改成「项目 + 名字」（#502）。
 */
export const agents = pgTable(
	"agents",
	{
		name: text("name").primaryKey(),
		projectId: text("project_id")
			.$type<ProjectId>()
			.notNull()
			.references(() => projects.id),
		info: jsonb("info").$type<AgentInfo>().notNull(),
		status: text("status").$type<AgentStatus>().notNull(),
		registeredAt: timestamptz("registered_at").notNull(),
		lastSeenAt: timestamptz("last_seen_at").notNull(),
		/** 最近一次 Hello 或 Heartbeat 测得的时钟偏差（Agent 时间 − 控制面时间，毫秒，#172）；未知时为空。 */
		clockOffsetMs: bigint("clock_offset_ms", { mode: "number" }),
		/** 测得 clock_offset_ms 的控制面时间。 */
		clockOffsetMeasuredAt: timestamptz("clock_offset_measured_at"),
		/** 停用这台 Agent 的时间（ADR 0029，#492）：停用的 Agent 不能连接、不参与派发；恢复时清空。 */
		disabledAt: timestamptz("disabled_at"),
		/**
		 * 最近一次连接用的凭据（#492）：「登记工作台之前，没有停用的 Agent 都必须已经换成 Agent 凭据」按它判断，
		 * 只签发过、没用它连上过的不算。记下之前连接的 Agent 为空。
		 */
		lastAuthKind: text("last_auth_kind").$type<AgentAuthKind>(),
	},
	(t) => [check("agents_last_auth_kind", sql`${t.lastAuthKind} in ('none', 'shared', 'agent')`)],
);

/**
 * 飞书机器人（ADR 0020）：按名称唯一，创建后不能改名。webhook_url 明文保存（相当于一个凭据，和 secret 参数一样），
 * 只在界面和日志里打码（src/feishu/webhook-url.ts）；接口不返回完整地址。
 * `last_delivery_*` 是最近一次投递（每发一次请求记一次，重试也算，丢弃不算）的控制面时间、是否送达和失败的原因（中文），
 * 管理页显示它；记在机器人上，不随投递记录的保留期清理。
 */
export const feishuBots = pgTable("feishu_bots", {
	name: text("name").primaryKey(),
	/** 所属项目（ADR 0029）；名字仍然全局唯一，第二步改成项目内唯一（#502）。 */
	projectId: text("project_id")
		.$type<ProjectId>()
		.notNull()
		.references(() => projects.id),
	webhookUrl: text("webhook_url").notNull(),
	createdAt: timestamptz("created_at").notNull(),
	lastDeliveryAt: timestamptz("last_delivery_at"),
	lastDeliveryOk: boolean("last_delivery_ok"),
	lastDeliveryError: text("last_delivery_error"),
});

/**
 * 关注项最后一次修改的记录（`orchestrations.focus_edit`）：谁、什么时候（控制面时间，ISO 8601）、一句话说明，
 * 以及修改之前的列表：下一次写入恰好把它写回去时，说明记为「撤销」。刚刚撤销过的修改没有可以再撤销的列表。
 */
export interface StoredFocusEdit {
	by: string;
	/** 修改人的用户 ID（ADR 0029）；升级之前记下的、以及没有登录身份的修改为空（旧记录没有这个键）。 */
	by_user_id?: string | null;
	at: string;
	summary: string;
	before: FocusItemInput[] | null;
}

/**
 * 场景：记录当前最新版本号（0 表示还没有保存过版本）。名称和说明不属于版本内容，可以随时修改（#33）。
 * 归档（#33）：archived_at 不为空时不出现在默认列表、不能触发；不物理删除。
 */
export const orchestrations = pgTable(
	"orchestrations",
	{
		id: uuid("id").primaryKey(),
		/**
		 * 所属项目（ADR 0029）；名字没有唯一约束，也不加。场景不能换项目：有运行的场景改 `project_id` 会被
		 * `runs` 上的组合外键（`runs_orchestration_project_fk`，NO ACTION）拒绝。ADR 里没有「把场景搬到别的项目」
		 * 的功能；以后要做时另行设计（在同一个事务里显式地改场景和运行，并处理任务凭据、项目密钥这些带着自己
		 * `project_id` 的相关行）。
		 */
		projectId: text("project_id")
			.$type<ProjectId>()
			.notNull()
			.references(() => projects.id),
		name: text("name").notNull(),
		description: text("description").notNull().default(""),
		headVersion: integer("head_version").notNull().default(0),
		createdAt: timestamptz("created_at").notNull(),
		archivedAt: timestamptz("archived_at"),
		/**
		 * 运行通知设置（GLOSSARY「运行通知」，ADR 0020）：和名称、说明一样不属于版本，运行结束时读取当前值。
		 * bot 为空即关闭；bot 不是外键，机器人被删除后设置原样保留（运行结束时记为「未发送」）。
		 */
		runNotifyBot: text("run_notify_bot"),
		runNotifyTrigger: text("run_notify_trigger")
			.$type<RunNotificationTrigger>()
			.notNull()
			.default("failed"),
		/** 卡片标题；空字符串时用场景名。 */
		runNotifyTitle: text("run_notify_title").notNull().default(""),
		/** 附加说明（Markdown）；空字符串即没有。 */
		runNotifyNote: text("run_notify_note").notNull().default(""),
		/**
		 * 关注项（GLOSSARY「关注项」）：场景挑出来、运行中重点展示的图表，按作者设定的顺序，最多 FOCUS_ITEMS_MAX 项
		 * （包括已经失效的）。和运行通知一样不属于版本，改了立即生效。节点 ID 跨版本稳定，图表按标题引用；
		 * 节点在最新版本里的状态每次读的时候对照得出，不存。
		 */
		focusItems: jsonb("focus_items").$type<FocusItemInput[]>().notNull().default([]),
		/** 关注项最后一次修改；从没改过时为空。 */
		focusEdit: jsonb("focus_edit").$type<StoredFocusEdit>(),
	},
	(t) => [
		// 给 `runs` 的组合外键（运行的项目恒等于它的场景的项目）当目标；`id` 已经是主键，这条约束只为了让外键有可引用的唯一组合。
		unique("orchestrations_id_project").on(t.id, t.projectId),
		// 运行通知的触发条件只有这两个值（#446 去掉了 always）：库里不能有认不出的值，运行结束时就不会读到它。
		check(
			"orchestrations_run_notify_trigger",
			sql`${t.runNotifyTrigger} in ('failed', 'failed_or_cancelled')`,
		),
	],
);

/**
 * 运行预设（GLOSSARY「运行预设」，ADR 0024）：场景的设置，不属于版本。values 是「参数名 → 值」，
 * 键就是预设参数的名单；名称在同一个场景内唯一（区分大小写）。场景不物理删除，不需要级联。
 */
export const runPresets = pgTable(
	"run_presets",
	{
		id: uuid("id").primaryKey(),
		orchestrationId: uuid("orchestration_id")
			.notNull()
			.references(() => orchestrations.id),
		name: text("name").notNull(),
		description: text("description").notNull().default(""),
		values: jsonb("values").$type<Record<string, unknown>>().notNull(),
		createdAt: timestamptz("created_at").notNull(),
		updatedAt: timestamptz("updated_at").notNull(),
		/** 最后修改人的昵称。 */
		updatedBy: text("updated_by").notNull(),
		/** 最后修改人的用户 ID（ADR 0029）；升级之前的记录为空，昵称列照旧保留。 */
		updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
	},
	(t) => [unique("run_presets_name").on(t.orchestrationId, t.name)],
);

/** 编排版本：不可变，同一编排内编号唯一、递增。 */
export const orchestrationVersions = pgTable(
	"orchestration_versions",
	{
		id: uuid("id").primaryKey(),
		orchestrationId: uuid("orchestration_id")
			.notNull()
			.references(() => orchestrations.id),
		number: integer("number").notNull(),
		document: orchestrationDocument("document").notNull(),
		author: text("author").notNull(),
		/** 保存人的用户 ID（ADR 0029）；升级之前的版本为空，昵称列照旧保留。 */
		authorUserId: uuid("author_user_id").references(() => users.id),
		/** 经哪个 AI 编程助手保存（请求头 x-sfly-client 里的 agent/<名称>）；只是标注，浏览器里保存的为空。 */
		authorVia: text("author_via"),
		/** 经哪个令牌保存（令牌的名称，ADR 0029「经 …」）；用登录 Cookie 保存的为空。是可信的，和上面不经校验的标注分开记。 */
		authorToken: text("author_token"),
		/**
		 * 经哪个会话保存（ADR 0027、0029「经 …」）：依据是请求带的会话令牌，不是模型在对话里怎么说，
		 * 也不是可以伪造的 `x-sfly-client` 标注。不是会话保存的为空。
		 */
		sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "set null" }),
		createdAt: timestamptz("created_at").notNull(),
	},
	(t) => [
		unique("orchestration_versions_number").on(t.orchestrationId, t.number),
		// 删会话时数据库按它找引用它的版本（置空）：没有索引就要顺序扫整张表。
		index("orchestration_versions_session").on(t.sessionId).where(sql`${t.sessionId} is not null`),
	],
);

export type RunStatus = "running" | "success" | "failed" | "cancelled";
export type ChainStatus = RunStatus;
/**
 * 任务状态（docs/SEMANTICS.md §3.1）。skipped（#11）：前面的节点失败、本节点不是 always，
 * 记一行 attempt 1 的占位（没有派发，不算一次尝试）。
 * cancelled（#12）：运行被取消；没有开始执行（started_at 为空）的行是占位，不算一次尝试。
 */
/** waiting：停止子流程节点在等被停止的子流程结束，不占用 Agent。 */
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

/**
 * 一次尝试写进日志的 WARN / ERROR（src/logs/task-logs.ts）：总条数和最近一条。写日志时更新，关注项判断异常时读它，
 * 不扫日志文件。
 */
export interface TaskLogIssues {
	count: number;
	/** 最近一条的级别。 */
	level: "warn" | "error";
	/** 最近一条的控制面时间（ISO）。 */
	at: string;
	/** 最近一条的正文（secret 已打码），截到 500 个字符。 */
	text: string;
}

export type { ErrorKind };

/** 运行：绑定一个编排版本。params 是填充默认值并覆盖后的入口参数。 */
export const runs = pgTable(
	"runs",
	{
		id: uuid("id").primaryKey(),
		orchestrationId: uuid("orchestration_id").notNull(),
		orchestrationVersionId: uuid("orchestration_version_id")
			.notNull()
			.references(() => orchestrationVersions.id),
		/**
		 * 所属项目：冗余一列，和场景的项目一致（创建时从场景取）；按项目的运行列表、控制台统计和「经运行定位项目」都读它，
		 * 不用每次联表（ADR 0029）。「和场景一致」由库里的组合外键 `runs_orchestration_project_fk` 保证：
		 * `(orchestration_id, project_id)` 必须是 `orchestrations (id, project_id)` 里存在的一对。
		 */
		projectId: text("project_id").$type<ProjectId>().notNull(),
		triggeredBy: text("triggered_by").notNull(),
		/** 触发人的用户 ID（ADR 0029）；升级之前的运行为空，昵称列照旧保留。 */
		triggeredByUserId: uuid("triggered_by_user_id").references(() => users.id),
		/** 经哪个 AI 编程助手触发；只是标注，浏览器里触发的为空。 */
		triggeredVia: text("triggered_via"),
		/** 经哪个令牌触发（令牌的名称，ADR 0029「经 …」）；用登录 Cookie 触发的为空。 */
		triggeredToken: text("triggered_token"),
		/**
		 * 经哪个会话触发（ADR 0027、0029「经 …」）：依据是请求带的会话令牌，不是模型在对话里怎么说；
		 * 会话只能取消自己触发的运行，会话页的成果栏也只认它。不是会话触发的为空。会话删除时置空：运行不随会话删除。
		 */
		sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "set null" }),
		/** 会话令牌触发、会话没勾选「联调时可以使用项目密钥」：secret 参数不解析（#497），触发时定下。 */
		secretsWithheld: boolean("secrets_withheld").notNull().default(false),
		params: jsonb("params").$type<Record<string, unknown>>().notNull(),
		/**
		 * 触发时选用的运行预设：ID（不是外键，预设删除后仍保留）、触发时的名称、预设参数的名单。
		 * 不用预设时三列都为空。
		 */
		presetId: uuid("preset_id"),
		presetName: text("preset_name"),
		presetParams: jsonb("preset_params").$type<string[]>(),
		status: text("status").$type<RunStatus>().notNull(),
		startedAt: timestamptz("started_at").notNull(),
		endedAt: timestamptz("ended_at"),
		/** 第一次取消（#12）的时间和昵称；之后运行在所有链结束时标记为 cancelled。 */
		cancelRequestedAt: timestamptz("cancel_requested_at"),
		cancelRequestedBy: text("cancel_requested_by"),
		/** 第一次取消的人的用户 ID（ADR 0029）；升级之前的取消为空。 */
		cancelRequestedByUserId: uuid("cancel_requested_by_user_id").references(() => users.id),
		/** 第一次取消经哪个 AI 编程助手发起；浏览器里取消的为空。 */
		cancelRequestedVia: text("cancel_requested_via"),
		/** 第一次取消经哪个令牌发起（令牌的名称，ADR 0029「经 …」）；用登录 Cookie 取消的为空。 */
		cancelRequestedToken: text("cancel_requested_token"),
		/** 清理期间再次取消（强制取消）的时间：always 节点也立即终止。 */
		cancelForcedAt: timestamptz("cancel_forced_at"),
		/** 日志和产物超过保留期被清理的时间（#18，src/retention/retention.ts）；未清理时为空。 */
		purgedAt: timestamptz("purged_at"),
		/** 指标超过保留期被判定过期的时间（#32，src/metrics/metric-retention.ts）；之后摘要等接口返回「已过保留期」。 */
		metricsPurgedAt: timestamptz("metrics_purged_at"),
		/**
		 * 运行通知（#232）：运行结束时场景设置选了机器人、而且满足触发条件，这里记下发给哪个机器人；
		 * 消息本身在发送队列里（source run_notification，run_id 是这个运行），投递结果以队列为准。
		 * 没有发运行通知时为空。
		 */
		notificationBot: text("notification_bot"),
		/** 运行结束时没有把消息写进队列的原因（机器人已不存在，或卡片超过 20 KB）；写进队列了为空。 */
		notificationNotSent: text("notification_not_sent"),
		/** 写进库的值在写入时就打了码（#505）：有加密副本，读取时不再打码；之前的运行照旧在读取时打码。 */
		maskedOnWrite: boolean("masked_on_write").notNull().default(false),
		/** 写入时打码的运行，secret 值合计太长、写进库的文字整段盖住了（`SecretSet.oversize`）：读取时不再有值集合，记在这里。 */
		secretsOversize: boolean("secrets_oversize").notNull().default(false),
		/** 加密副本删除的时刻（#505）：之后到达的上报一律丢弃，计在 `late_reports_dropped`。 */
		vaultDeletedAt: timestamptz("vault_deleted_at"),
		/** 加密副本删除之后到达、被丢弃的上报条数（日志、进度、动作、通知、指标、结果，每条消息算一条）。 */
		lateReportsDropped: integer("late_reports_dropped").notNull().default(0),
	},
	(t) => [
		// 运行的项目恒等于它的场景的项目，由这条组合外键保证；更新和删除都不级联（NO ACTION）：有运行的场景改项目
		// 被拒绝（不让一条 update 悄悄把运行搬到别的项目），场景不物理删除。同时代替了原来 `project_id` 上单独的
		// 外键（项目存在由 `orchestrations.project_id` 的外键间接保证）。以后要做「搬场景」时，把这条约束改成
		// DEFERRABLE（改属性不用重扫 `runs`），在同一个事务里显式地改场景和运行。
		foreignKey({
			name: "runs_orchestration_project_fk",
			columns: [t.orchestrationId, t.projectId],
			foreignColumns: [orchestrations.id, orchestrations.projectId],
		}),
		// 一个场景的运行：按场景取，又按开始时间倒序（场景的运行列表、运行记录按场景筛选、每个场景最近一次运行）。
		// 带 started_at 和 id：运行记录总带着项目条件（`runs_project_started`），规划器否则会倒着扫项目的索引、
		// 一行行过滤场景，场景的运行少又都是最早的时候要扫过整个项目的运行（test/run-list-plan.test.ts）。
		index("runs_orchestration").on(t.orchestrationId, t.startedAt, t.id),
		index("runs_ended_at").on(t.endedAt),
		// 按项目的运行列表：项目内按开始时间从新到旧（倒序扫描这条索引）。
		index("runs_project_started").on(t.projectId, t.startedAt, t.id),
		// 删会话时数据库按它找引用它的运行（置空）：没有索引就要顺序扫整张表。
		index("runs_session").on(t.sessionId).where(sql`${t.sessionId} is not null`),
	],
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
		/**
		 * 派发时随任务下发的、「飞书机器人」类型的输入引用的机器人（AssignTask.referenced_feishu_bots，ADR 0020）：
		 * 节点用 ctx.notify 只能发给其中的机器人。之前派发的任务为空。
		 */
		referencedFeishuBots: text("referenced_feishu_bots").array().notNull().default([]),
		outputs: jsonb("outputs").$type<Record<string, unknown>>(),
		errorKind: text("error_kind").$type<ErrorKind>(),
		errorMessage: text("error_message"),
		/**
		 * 节点失败时出错的位置（TaskError.location）：节点代码里的那一行，「模块.函数 第 N 行」。
		 * 不是节点出错、取不到位置、旧版本 Agent 或 SDK 上报的、升级之前的任务为空。
		 */
		errorLocation: text("error_location"),
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
		/** 日志文件里最后一行的序号（src/logs/task-logs.ts）。 */
		logSeq: bigint("log_seq", { mode: "number" }).notNull().default(0),
		/** 已写入的 Agent 日志行里最大的 Agent 序号（Agent 序号不大于它的行视为重复）。 */
		logAgentSeq: bigint("log_agent_seq", { mode: "number" }).notNull().default(0),
		/** 日志超过上限已被截断（#18）：写入了截断标记，之后的行都被丢弃。 */
		logTruncated: boolean("log_truncated").notNull().default(false),
		/** 日志里的 WARN / ERROR（{@link TaskLogIssues}）；还没有写过时为空。 */
		logIssues: jsonb("log_issues").$type<TaskLogIssues>(),
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
		/** 已存下的动作和标记的明细条数（规格 #345，`task_actions`）；控制面兜底的合计上限按它判断。 */
		actionDetails: integer("action_details").notNull().default(0),
		/** 明细的修订号：每写入一批加一，写入或结束的明细记下这个值（`task_actions.rev`），实时推送按它接续。 */
		actionRev: bigint("action_rev", { mode: "number" }).notNull().default(0),
		/** 控制面兜底丢弃过明细：任务日志里的警告已经写过（每个任务只写一次）。 */
		actionCapped: boolean("action_capped").notNull().default(false),
		/** 控制面在 Welcome 里告诉这台 Agent 放弃这次尝试的时刻（#505，`engine/released.ts`）。 */
		abandonedAt: timestamptz("abandoned_at"),
		/** 这次尝试离开 Agent 之手的时刻（#505，`engine/released.ts`）；从没派发出去的（`lease_expires_at` 为空）不用记。 */
		releasedAt: timestamptz("released_at"),
	},
	(t) => [
		// 还在（或可能还在）Agent 手上的尝试：重连、心跳时按 Agent 找它们。
		index("tasks_unreleased")
			.on(t.agentName)
			.where(sql`${t.leaseExpiresAt} is not null and ${t.releasedAt} is null`),
		index("tasks_lease").on(t.leaseExpiresAt).where(sql`${t.status} = 'running'`),
		index("tasks_queue_timeout").on(t.queueExpiresAt).where(sql`${t.status} = 'queued'`),
		unique("tasks_attempt").on(t.chainInstanceId, t.nodeId, t.attempt),
		index("tasks_agent_status").on(t.agentName, t.status),
		index("tasks_chain_instance").on(t.chainInstanceId),
	],
);

/**
 * 任务最新的一份动作摘要（规格 #345，src/actions/task-actions.ts）：每一份都是完整的，新的整个替换旧的。
 * 和任务行分开存：一份可以有几百 KB，引擎和运行视图读任务行时不用把它读出来。保留期和日志相同（src/retention/retention.ts）。
 */
export const taskActionSummaries = pgTable("task_action_summaries", {
	taskId: uuid("task_id")
		.primaryKey()
		.references(() => tasks.id),
	/** 时间已经折算好、secret 值已经打码的摘要；正在做的动作在任务结束后由读取的一方当作空的。用 json 而不是 jsonb：保留字段的先后。 */
	summary: json("summary").$type<StoredActionSummary>().notNull(),
	/** 从摘要里选出的此刻在做的动作：运行视图、Agent 列表只读这一列。 */
	currentAction: jsonb("current_action").$type<CurrentAction>(),
});

/**
 * 动作和标记的明细（规格 #345，src/actions/task-actions.ts）：每个动作、标记一行，ID 是 SDK 分配的任务内 ID。
 * 时间已经折算好、secret 值已经打码；还在做的动作结果为空，任务结束以后由读取的一方记为未结束。
 * 没有指向任务的外键：一批最多 1000 行，外键检查在写入路径上逐行执行（与 `metric_segments` 一样）；
 * 写入前已经确认任务存在。
 */
export const taskActions = pgTable(
	"task_actions",
	{
		taskId: uuid("task_id").notNull(),
		id: bigint("id", { mode: "number" }).notNull(),
		kind: text("kind").$type<"action" | "mark">().notNull(),
		parent: bigint("parent", { mode: "number" }),
		depth: integer("depth").notNull(),
		name: text("name").notNull(),
		/** 开始时给的字段：`json` 而不是 `jsonb`，保留写入的先后。 */
		fields: json("fields").$type<Record<string, string>>().notNull(),
		/** 结束时补充的字段（note()），读取时覆盖到 `fields` 上；开始和结束在同一批时直接写进 `fields`。 */
		noted: json("noted").$type<Record<string, string>>(),
		startedAt: timestamptz("started_at").notNull(),
		agentStartedAt: timestamptz("agent_started_at").notNull(),
		/** 开始的单调时钟读数（毫秒）：耗时是结束与它的差，Agent 的系统时间被改动不影响。 */
		startMono: bigint("start_mono", { mode: "number" }).notNull(),
		endedAt: timestamptz("ended_at"),
		agentEndedAt: timestamptz("agent_ended_at"),
		durationMs: bigint("duration_ms", { mode: "number" }),
		result: text("result").$type<ActionResult>(),
		reason: text("reason"),
		/** 最后写入这一行（开始或结束）的那一批的修订号（`tasks.action_rev`）。 */
		rev: bigint("rev", { mode: "number" }).notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.taskId, t.id] }),
		index("task_actions_started").on(t.taskId, t.startedAt, t.id),
		index("task_actions_name").on(t.taskId, t.name, t.startedAt, t.id),
		index("task_actions_failed").on(t.taskId, t.startedAt, t.id).where(sql`${t.result} = 'failed'`),
		index("task_actions_rev").on(t.taskId, t.rev, t.id),
	],
);

/**
 * 每个任务每种名称的明细计数（规格 #345）：控制面兜底的每种名称上限按 `stored` 判断，被丢弃的个数和其中最早的
 * 开始时间是「只计数的段」里 `control_plane` 那一段。
 */
export const taskActionNames = pgTable(
	"task_action_names",
	{
		taskId: uuid("task_id")
			.notNull()
			.references(() => tasks.id),
		name: text("name").notNull(),
		/** 存下的明细个数，不含补发的失败动作（它们只受合计上限的限制）。 */
		stored: integer("stored").notNull().default(0),
		/** 控制面兜底丢弃的个数。 */
		dropped: integer("dropped").notNull().default(0),
		/** 被丢弃的明细里最早的开始时间（控制面时间、Agent 时间）；没有丢弃过时为空。 */
		droppedFrom: timestamptz("dropped_from"),
		agentDroppedFrom: timestamptz("agent_dropped_from"),
	},
	(t) => [primaryKey({ columns: [t.taskId, t.name] })],
);

/**
 * 飞书消息的来源：`ctx.notify`、运行通知。历史记录里还有 `node`：已移除的飞书通知节点（ADR 0028）发的消息，
 * 读的地方不分来源，所以不留在类型里。
 */
export type FeishuMessageSource = "notify" | "run_notification";
export type FeishuMessageStatus = "queued" | "delivered" | "failed" | "discarded";

/**
 * 飞书发送队列（ADR 0020）：消息先写进这里，再由控制面投递
 * （src/feishu/feishu-delivery.ts）。同一个机器人的消息按 `seq`（入队顺序）串行投递；投递的结果只记在这里和任务日志里，
 * 从不改变节点、任务、链或运行的状态。`bot_name` 不是外键：机器人删除后，它没有投递的消息记为已丢弃。
 * 可重试的失败之后消息仍然排队：`attempts` 记已经尝试的次数，`next_attempt_at`（控制面时间）是最早的下一次尝试，
 * 重启之后继续按它算。投递记录跟随所属运行的保留期。
 */
export const feishuMessages = pgTable(
	"feishu_messages",
	{
		/** 入队顺序。 */
		seq: bigserial("seq", { mode: "number" }).primaryKey(),
		botName: text("bot_name").notNull(),
		source: text("source").$type<FeishuMessageSource>().notNull(),
		/** 发起这条消息的运行和任务（`ctx.notify`、运行通知的运行）；投递结果写进这个任务的日志。 */
		runId: uuid("run_id").references(() => runs.id),
		taskId: uuid("task_id").references(() => tasks.id),
		/** 完整的飞书请求体。 */
		body: jsonb("body").$type<Record<string, unknown>>().notNull(),
		/** 入队时间（控制面时间）。 */
		enqueuedAt: timestamptz("enqueued_at").notNull(),
		status: text("status").$type<FeishuMessageStatus>().notNull().default("queued"),
		attempts: integer("attempts").notNull().default(0),
		/** 可重试的失败之后，最早的下一次尝试（控制面时间）；还没有失败过、或已经有结果时为空。 */
		nextAttemptAt: timestamptz("next_attempt_at"),
		/** 最后一次失败（或丢弃）的原因，中文，Webhook 地址已打码。 */
		lastError: text("last_error"),
		/** 送达、失败或丢弃的时间。 */
		finishedAt: timestamptz("finished_at"),
	},
	(t) => [index("feishu_messages_queued").on(t.botName, t.seq).where(sql`${t.status} = 'queued'`)],
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
		/**
		 * 所属项目（ADR 0029）：发布到哪个项目就属于哪个；标准节点包（`sfly-std`）的已发布版本属于公共项目。
		 * `名字@版本` 仍然全局唯一（主键不变），第二步改成「项目 + 名字 + 版本」（#502）；同一个名字的不同版本现在可以分属两个项目。
		 */
		projectId: text("project_id")
			.$type<ProjectId>()
			.notNull()
			.references(() => projects.id),
		metadata: jsonb("metadata").$type<PackageMetadata>().notNull(),
		/** 相对控制面数据目录的路径。 */
		filePath: text("file_path").notNull(),
		sha256: text("sha256").notNull(),
		size: bigint("size", { mode: "number" }).notNull(),
		publishedAt: timestamptz("published_at").notNull(),
		/** 发布人（#501）：显示名、用户 ID，以及经哪个令牌发布（令牌的名称）。升级之前发布的版本都为空：当时发布不要任何身份。 */
		publishedBy: text("published_by"),
		publishedByUserId: uuid("published_by_user_id").references(() => users.id),
		publishedToken: text("published_token"),
		/**
		 * 会话构建（#795，`src/packages/session-builds.ts`）属于哪个会话；正式版本为空。会话构建只能被这个会话的场景版本锁定，
		 * 不进包列表、最新和默认版本；会话结束、没有没结束的运行用它之后由周期清理删掉（行和归档文件）。
		 */
		sessionId: uuid("session_id"),
	},
	(t) => [
		primaryKey({ columns: [t.name, t.version] }),
		// 会话构建和它的会话在同一个项目里。会话删不掉，除非它的会话构建已经回收：归档文件不会没人管。
		foreignKey({
			name: "node_packages_session_project_fk",
			columns: [t.sessionId, t.projectId],
			foreignColumns: [sessions.id, sessions.projectId],
		}).onDelete("restrict"),
		// 列出一个会话的会话构建、回收时按会话找。
		index("node_packages_session").on(t.sessionId).where(sql`${t.sessionId} is not null`),
	],
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

// ---------------------------------------------------------------------------------------------------------------
// 用户与项目（ADR 0029）。第一次迁移只建表和回填，不改变任何接口的行为：登录、令牌、鉴权在后面的任务里加上
// （#489–#492），这里的列按各任务要用的形状一次留够，后面的任务只往里加数据。
// ---------------------------------------------------------------------------------------------------------------

/**
 * 用户：平台本地的账号。登录名的字符集不含连字符（开发 Agent 的名字 `dev-<登录名>-<主机>` 靠这一点没有歧义）：
 * 小写字母、数字、下划线，长度 1–32，由库里的约束保证。显示名不受限制。
 * 密码哈希是 `crypto.scrypt` 的存储串（盐和参数写在串里，#490）；只靠外部身份登录的用户没有密码，但两者至少有一个。
 * 外部身份留给以后接反向代理头或 OIDC（不用再迁移）。停用的用户登录、令牌和他发起的会话全部立即失效。
 */
export const users = pgTable(
	"users",
	{
		id: uuid("id").primaryKey(),
		loginName: text("login_name").notNull(),
		displayName: text("display_name").notNull(),
		passwordHash: text("password_hash"),
		/** 停用的时间；没有停用为空。 */
		disabledAt: timestamptz("disabled_at"),
		/** 平台管理员：建项目、管理账号、维护公共项目，并在每个项目里拥有项目管理员的权限。 */
		isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
		externalIdentity: text("external_identity"),
		createdAt: timestamptz("created_at").notNull(),
	},
	(t) => [
		unique("users_login_name").on(t.loginName),
		uniqueIndex("users_external_identity")
			.on(t.externalIdentity)
			.where(sql`${t.externalIdentity} is not null`),
		check("users_login_name_format", sql`${t.loginName} ~ '^[a-z0-9_]{1,32}$'`),
		check(
			"users_can_authenticate",
			sql`${t.passwordHash} is not null or ${t.externalIdentity} is not null`,
		),
	],
);

/**
 * 项目：平台的顶层租户（ADR 0029）。标识不可修改（小写字母、数字、连字符，出现在路径里），所以它就是主键，
 * 其余表的 `project_id` 直接存它；显示名可以修改。迁移时建两个：默认项目 `default` 和公共项目 `public`。
 */
export const projects = pgTable(
	"projects",
	{
		id: text("id").$type<ProjectId>().primaryKey(),
		displayName: text("display_name").notNull(),
		createdAt: timestamptz("created_at").notNull(),
		/**
		 * 这个项目的工作台：一台 Agent 的名字（ADR 0027、#549），没有登记为空。助手的会话在这台 Agent 上做事；
		 * 部署里**任何一个项目**登记了工作台，控制面就只接受 Agent 凭据（共享令牌和没有凭据的连接都拒绝，
		 * ADR 0029「迁移与过渡」）。登记在 `PUT /projects/:project/workbench`（`ProjectWorkbench.register`），
		 * 不加外键：Agent 的行在它第一次连上时才有，登记之后 Agent 可以离线、被停用，这些由会话的就绪状态说明。
		 */
		workbenchAgent: text("workbench_agent"),
	},
	(t) => [check("projects_id_format", sql`${t.id} ~ '^[a-z0-9][a-z0-9-]{0,62}$'`)],
);

/** 成员的角色：每种角色是固定的一组范围（ADR 0029 的范围表），检查只看范围，不看角色名。 */
export type ProjectRole = "read_only" | "editor" | "project_admin";

/** 成员：一个用户在一个项目里的身份，带一种角色。 */
export const projectMembers = pgTable(
	"project_members",
	{
		projectId: text("project_id")
			.$type<ProjectId>()
			.notNull()
			.references(() => projects.id),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id),
		role: text("role").$type<ProjectRole>().notNull(),
		createdAt: timestamptz("created_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.projectId, t.userId] }),
		// 一个用户在哪些项目里。
		index("project_members_user").on(t.userId),
		check("project_members_role", sql`${t.role} in ('read_only', 'editor', 'project_admin')`),
	],
);

/**
 * 助手会话（GLOSSARY「会话」，ADR 0027）：用户和助手围绕一件事的一次对话，属于一个项目（竖切里都是 `default`）。
 * `status` 一次写全（`idle` 空闲、`running` 在做、`queued` 排队中、`ended` 已结束），骨架的竖切只用前两个；
 * 同一个项目同一时刻只跑一轮：每个项目至多一个 `running` 的会话（`sessions_one_running_per_project`），
 * 并发的两个「开始一轮」只有一个能写成功。`title` 是第一句话的前 60 个字（看起来的字，超过时末尾加「…」，截法见 `titleOf`；之前创建的会话不迁移）；`created_by` 是发起人的昵称，
 * `created_by_user_id` 是发起人的用户（#494 之前的请求可能没有用户，#547 起建会话要有用户）。
 * `last_activity_at` 是最近一次活动（新建、发话、事件落库）。
 */
export const sessions = pgTable(
	"sessions",
	{
		id: uuid("id").primaryKey(),
		projectId: text("project_id")
			.$type<ProjectId>()
			.notNull()
			.references(() => projects.id),
		title: text("title").notNull(),
		status: text("status").$type<SessionStatus>().notNull(),
		createdBy: text("created_by").notNull(),
		createdByUserId: uuid("created_by_user_id").references(() => users.id),
		createdAt: timestamptz("created_at").notNull(),
		/** 最近一次有动静的时间：用控制面的时钟记（不是助手服务盖的事件时间，它的时钟偏了也不影响兜底判断）。 */
		lastActivityAt: timestamptz("last_activity_at").notNull(),
		/**
		 * 最近一次开始的轮次（`turn_started` 的条数）：在做时就是正在做的那一轮。和「改成在做、写 `user_message`、写
		 * `turn_started`」在同一个事务里加一；助手服务发来的事件要带这个轮次才收，控制面结束一轮时也按它核对。
		 */
		currentTurn: integer("current_turn").notNull().default(0),
		/**
		 * 开始排队的时间（#544）：排队中（`queued`）的会话一定有；在做（`running`）的会话在**这一轮正在停止时用户又说了话**
		 * 的话也有（这句话排在这一轮后面，这一轮的结局写下之后会话改成 `queued`、保留这个时间）；其余为 null。同一个项目里
		 * 排队的会话按它先后轮流开始（最早的先开始，同一时刻的按 ID，按说话的时刻排，不插队），控制面记的时间，不是助手服务盖的。
		 */
		queuedAt: timestamptz("queued_at"),
		/** 「联调时可以使用项目密钥」（#497）：人勾选；没勾选时会话令牌触发的运行不解析 secret 参数。 */
		useProjectSecrets: boolean("use_project_secrets").notNull().default(false),
	},
	(t) => [
		check("sessions_current_turn", sql`${t.currentTurn} >= 0`),
		// 排队中的会话一定有排队时间；有排队时间的只有排队中的和在做的（停止途中说了话），空闲、已结束的没有。
		check(
			"sessions_queued_at",
			sql`(${t.queuedAt} is null and ${t.status} <> 'queued') or (${t.queuedAt} is not null and ${t.status} in ('queued', 'running'))`,
		),
		// 一个项目里排队的会话，最早的在前（轮到谁开始、排第几）。
		index("sessions_project_queue")
			.on(t.projectId, t.queuedAt, t.id)
			.where(sql`${t.queuedAt} is not null`),
		// 会话令牌的组合外键（`api_tokens(session_id, project_id)`）指向它：令牌的项目恒等于它所属会话的项目。
		unique("sessions_id_project").on(t.id, t.projectId),
		// 一个项目的会话列表，最近活动在前。
		index("sessions_project_activity").on(t.projectId, t.lastActivityAt),
		uniqueIndex("sessions_one_running_per_project")
			.on(t.projectId)
			.where(sql`${t.status} = 'running'`),
		check("sessions_status", sql`${t.status} in ('idle', 'running', 'queued', 'ended')`),
	],
);

/**
 * 会话的持久事件（ADR 0027，类型在 `@sfly/schema` 的 `sessions.ts`）：只存持久的那几类，文字增量、工具的输出、
 * 思考、排队状态、快照只推不存。`seq` 是会话内序号，从 1 起，严格递增、不重复（控制面在同一个事务里锁住会话那一行
 * 再取下一个，src/sessions/session-store.ts）；`payload` 是事件里除 `type` 以外的字段；`created_at` 是事件产生的时间
 * （助手服务产生的由它盖时间，控制面自己产生的用控制面的时钟，#538），不是落库的时间。
 * 会话删除时事件一起删。
 */
export const sessionEvents = pgTable(
	"session_events",
	{
		sessionId: uuid("session_id")
			.notNull()
			.references(() => sessions.id, { onDelete: "cascade" }),
		seq: integer("seq").notNull(),
		type: text("type").notNull(),
		payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
		createdAt: timestamptz("created_at").notNull(),
		// 助手服务发来的持久事件在助手服务里的位置（纪元加纪元内的序号，#545）：重连时重复收到的事件不存两次
		// （`session_events_assistant_source` 唯一），控制面重启后用最后一条的位置接着收。控制面自己写的事件没有这两列。
		assistantEpoch: text("assistant_epoch"),
		assistantSeq: bigint("assistant_seq", { mode: "number" }),
	},
	(t) => [
		primaryKey({ columns: [t.sessionId, t.seq] }),
		check("session_events_seq", sql`${t.seq} >= 1`),
		check(
			"session_events_assistant_source",
			sql`(${t.assistantEpoch} is null) = (${t.assistantSeq} is null)`,
		),
		// 纪元和序号是整个助手服务共用的，不分会话：同一个位置的事件只存一条。只覆盖有位置的行（控制面自己写的事件两列都空，
		// 不占索引）；`hello` 时按纪元查最大序号（`lastSeqOfEpoch`）也走它。
		uniqueIndex("session_events_assistant_source_idx")
			.on(t.assistantEpoch, t.assistantSeq)
			.where(sql`${t.assistantEpoch} is not null`),
		// 控制面（重）启动时找最后收到的那条助手事件：纪元是随机串、没有先后，按事件产生的时间（助手服务盖的）往回找。
		index("session_events_assistant_latest")
			.on(t.createdAt.desc(), t.assistantSeq.desc())
			.where(sql`${t.assistantEpoch} is not null`),
		// 「上一轮的结局」（会话视图和列表里的 last_turn_outcome）取每个会话最近一条 turn_end：只给 turn_end 建索引
		// （每轮一条），按序号倒序，查询不用扫整个会话的事件（几万条）。谓词写成字面量，查询里也要写成字面量才用得上它。
		index("session_events_turn_end")
			.on(t.sessionId, t.seq.desc())
			.where(sql`${t.type} = 'turn_end'`),
	],
);

/**
 * 令牌的种类（ADR 0029「凭据」）：个人令牌属于用户，项目令牌属于项目，会话令牌属于一个会话（#495），
 * 任务凭据属于一次任务尝试（#492）。会话令牌和任务凭据的种类先留出来，签发它们的任务再加。
 * Agent 凭据不在这里：它有自己的表（`agent_credentials`）。
 */
export type ApiTokenKind = "personal" | "project" | "session" | "task";

/**
 * 令牌：命令行、API 客户端、自动化、助手会话和任务里的 SDK 调用平台用的凭据。库里只存 SHA-256 哈希，
 * 原值只在签发时显示一次；`prefix` 是展示用的前缀（种类前缀加原值开头的几个字符），日志和列表里据此认出是哪一个。
 * 各种类用到的列由 `api_tokens_shape` 约束：
 * - 个人令牌：`user_id` 是所属用户，`project_id` 可选，限定在一个项目里；
 * - 项目令牌：`project_id` 是所属项目（服务账号），没有用户；
 * - 会话令牌：代发起人（`user_id`）、限一个项目（`project_id`）、属于一个会话（`session_id`，外键到 `sessions`）；
 * - 任务凭据：限本项目（`project_id`），属于一次任务尝试（`task_id` 是 `tasks.id`），没有用户。
 * `scopes` 是范围的名字（读、运行、编辑、会话构建、发布、管理，由鉴权模块定，库里不约束：加范围不用迁移）。
 * 令牌只吊销（`revoked_at`），不物理删除：「经 …」按令牌的名称记在运行和场景版本上。
 */
export const apiTokens = pgTable(
	"api_tokens",
	{
		id: uuid("id").primaryKey(),
		kind: text("kind").$type<ApiTokenKind>().notNull(),
		name: text("name").notNull(),
		prefix: text("prefix").notNull(),
		tokenHash: text("token_hash").notNull(),
		userId: uuid("user_id").references(() => users.id),
		projectId: text("project_id")
			.$type<ProjectId>()
			.references(() => projects.id),
		sessionId: uuid("session_id"),
		taskId: uuid("task_id"),
		/**
		 * 签发人（项目令牌记它，个人令牌的签发人就是所属用户，不另记）：项目令牌是项目的服务账号，**不随签发人失效**
		 * （签发人被停用、移出项目之后照样有效，ADR 0029「用户、项目与角色」），但要记下是谁签发的，列表和审计里看得到。
		 * 空：不是项目令牌，或者是这一列加进来之前签发的。
		 */
		issuedByUserId: uuid("issued_by_user_id").references(() => users.id),
		/**
		 * 任务凭据派发时这条连接用的那一个 Agent 凭据（#492）：任务凭据只在**它**没被吊销时有效，不看「这个名字此刻有没有别的
		 * 有效凭据」（全部吊销之后再给同名的 Agent 签发一个新的，旧连接上发出去的任务凭据不能因此又被认）。空：不是任务凭据，
		 * 或者连接用的是旧方式（共享令牌、没有凭据）的，或者是这一列加进来之前派发的；这几种只看这台 Agent 有没有停用。
		 * 凭据行删除时任务凭据随它删除（不认）。
		 */
		agentCredentialId: uuid("agent_credential_id").references(() => agentCredentials.id, {
			onDelete: "cascade",
		}),
		scopes: text("scopes").array().notNull(),
		createdAt: timestamptz("created_at").notNull(),
		expiresAt: timestamptz("expires_at"),
		revokedAt: timestamptz("revoked_at"),
		lastUsedAt: timestamptz("last_used_at"),
	},
	(t) => [
		unique("api_tokens_hash").on(t.tokenHash),
		// 会话令牌属于一个会话，并且和它在同一个项目里：令牌的项目恒等于会话的项目（组合外键，#547）。会话删除时令牌随它删除。
		// 两列任一为空时不检查（别的种类的令牌没有会话）；会话令牌的两列都不为空由下面的 `api_tokens_shape` 保证。
		foreignKey({
			name: "api_tokens_session_project_fk",
			columns: [t.sessionId, t.projectId],
			foreignColumns: [sessions.id, sessions.projectId],
		}).onDelete("cascade"),
		// 列出一个用户自己的令牌、一个项目的项目令牌。
		index("api_tokens_user").on(t.userId),
		index("api_tokens_project").on(t.projectId),
		// 任务结束时吊销它的凭据。
		index("api_tokens_task").on(t.taskId).where(sql`${t.taskId} is not null`),
		// 每一轮开始、结束时按会话吊销它还有效的会话令牌（#547，在会话那一行的行锁下做）：令牌只吊销、不删除，每一轮一行，
		// 没有它这条更新要顺序扫整张表。
		index("api_tokens_session").on(t.sessionId).where(sql`${t.sessionId} is not null`),
		check("api_tokens_kind", sql`${t.kind} in ('personal', 'project', 'session', 'task')`),
		check(
			"api_tokens_agent_credential_task",
			sql`${t.agentCredentialId} is null or ${t.kind} = 'task'`,
		),
		check(
			"api_tokens_shape",
			sql`(${t.kind} = 'personal' and ${t.userId} is not null and ${t.sessionId} is null and ${t.taskId} is null)
				or (${t.kind} = 'project' and ${t.projectId} is not null and ${t.userId} is null and ${t.sessionId} is null and ${t.taskId} is null)
				or (${t.kind} = 'session' and ${t.userId} is not null and ${t.projectId} is not null and ${t.sessionId} is not null and ${t.taskId} is null)
				or (${t.kind} = 'task' and ${t.projectId} is not null and ${t.taskId} is not null and ${t.userId} is null and ${t.sessionId} is null)`,
		),
	],
);

/**
 * 登录：控制台登录后发的 Cookie（#490）。库里只存 Cookie 的哈希；空闲超过 `idle_expires_at` 失效，
 * 每次使用往后顺延（写得多频繁由 #490 定，`last_used_at` 供节流）。注销（含「注销自己全部的登录」）记 `revoked_at`。
 * 「登录」这个词只指这个；助手的对话叫「会话」。
 */
export const logins = pgTable(
	"logins",
	{
		id: uuid("id").primaryKey(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id),
		cookieHash: text("cookie_hash").notNull(),
		createdAt: timestamptz("created_at").notNull(),
		lastUsedAt: timestamptz("last_used_at").notNull(),
		idleExpiresAt: timestamptz("idle_expires_at").notNull(),
		revokedAt: timestamptz("revoked_at"),
	},
	(t) => [unique("logins_cookie_hash").on(t.cookieHash), index("logins_user").on(t.userId)],
);

/**
 * Agent 凭据的种类：`agent` 按台签发（项目 + Agent 名字固定，#492）；`shared` 是旧式的共享令牌
 * （`SFLY_AGENT_TOKEN`），登记成默认项目的凭据，不限名字。
 */
export type AgentCredentialKind = "agent" | "shared";

/**
 * Agent 凭据（ADR 0029）：Agent 连接（`Hello.token`）和请求 HTTP 时（`Bearer`）出示的凭据，只存 SHA-256 哈希。
 * - 按台签发的（`agent`）：属于一个项目和一个 Agent 名字（Agent 第一次连上之前还没有 `agents` 的行，所以名字不是外键）；
 *   项目管理员签发的 `user_id` 为空，开发 Agent 的凭据记在签发它的编辑者名下（只有他自己和项目管理员能吊销）。
 *   同一个名字可以有几个有效的凭据（轮换期间新旧并存）。
 * - 共享令牌（`shared`）：控制面启动时配了 `SFLY_AGENT_TOKEN` 就登记一条（默认项目、不限名字、没有展示前缀）。
 */
export const agentCredentials = pgTable(
	"agent_credentials",
	{
		id: uuid("id").primaryKey(),
		kind: text("kind").$type<AgentCredentialKind>().notNull(),
		projectId: text("project_id")
			.$type<ProjectId>()
			.notNull()
			.references(() => projects.id),
		agentName: text("agent_name"),
		prefix: text("prefix"),
		tokenHash: text("token_hash").notNull(),
		userId: uuid("user_id").references(() => users.id),
		createdAt: timestamptz("created_at").notNull(),
		revokedAt: timestamptz("revoked_at"),
		lastUsedAt: timestamptz("last_used_at"),
	},
	(t) => [
		unique("agent_credentials_hash").on(t.tokenHash),
		index("agent_credentials_agent").on(t.projectId, t.agentName),
		check("agent_credentials_kind", sql`${t.kind} in ('agent', 'shared')`),
		check(
			"agent_credentials_shape",
			sql`(${t.kind} = 'agent' and ${t.agentName} is not null and ${t.prefix} is not null)
				or (${t.kind} = 'shared' and ${t.agentName} is null and ${t.userId} is null)`,
		),
	],
);

/**
 * 平台管理员在自己不是成员的项目里做的写操作（ADR 0029「用户、项目与角色」）：谁、什么时候、调用了什么、作用在哪个资源上。
 * 平台管理员在每个项目里都有项目管理员的权限，这是「另一个项目读不到」的例外，拦不住，所以对项目透明：项目的成员看得到
 * （查看页在 #499）。记录由契约路由的访问检查一处写（src/auth/access-guard.ts），不靠各接口自己记；先于处理函数写下，
 * 请求没做成（400、404、409…）也留着，靠 `status` 区分：请求结束时回填响应的状态码，进程在两者之间退出的留空，
 * 表示结果未知。只记写操作：他不是成员的项目里的写，以及他是成员、但这次写要靠平台管理员的权限才通过（他的角色没有这个范围）
 * 的写；角色本来就够的写、所有读操作都不记。`member_role` 区分这两种：不是成员为空，是成员记当时的角色
 * （不记成员的写，管理员先给自己加一个只读成员，之后的写就不留痕迹了）。
 */
export const platformAdminActions = pgTable(
	"platform_admin_actions",
	{
		id: uuid("id").primaryKey(),
		projectId: text("project_id")
			.$type<ProjectId>()
			.notNull()
			.references(() => projects.id),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id),
		at: timestamptz("at").notNull(),
		/** 契约里的方法和路径模板（`POST /orchestrations/:id/versions`），不是请求的实际地址。 */
		route: text("route").notNull(),
		/** 请求定位到的资源的类别（契约的 `resource.kind`）和定位它的值（路径参数、查询参数或请求体字段的值；列表和新建没有）。 */
		resourceKind: text("resource_kind").notNull(),
		resourceId: text("resource_id"),
		/** 经哪个令牌（令牌的名称）；用登录 Cookie 的为空。 */
		tokenName: text("token_name"),
		/** 他这时在这个项目里的角色；不是成员为空。 */
		memberRole: text("member_role").$type<ProjectRole>(),
		/**
		 * 响应的状态码，请求结束时回填（先记、记不上整个请求就失败，所以不会漏记；这一列在处理函数之后才写）。
		 * 只有 2xx、3xx、4xx 说明了结果；**空和 5xx 都按「结果未知」看待**：
		 * - 空：请求还在处理；进程在写这一列之前退出了；客户端在响应发出之前断开了（`onResponse` 不触发）；回填本身失败了（只记日志）。
		 * - 5xx：处理函数出错了，但出错之前可能已经做成了一部分，不等于没做成。
		 */
		status: integer("status"),
	},
	(t) => [
		index("platform_admin_actions_project").on(t.projectId, t.at),
		check(
			"platform_admin_actions_member_role",
			sql`${t.memberRole} in ('read_only', 'editor', 'project_admin')`,
		),
	],
);

export * from "./vault-schema.js";
export * from "./version-conflict-schema.js";
