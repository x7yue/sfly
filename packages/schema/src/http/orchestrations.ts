import { z } from "zod";
import { optionalLine } from "../display-text.js";
import { OrchestrationDocument } from "../orchestration-document.js";
import { ChartDeclaration } from "../package-metadata.js";
import { endpoint, Timestamp } from "./contract.js";
import { FeishuBotName } from "./feishu-bots.js";

/**
 * 场景（代码与路径里沿用 orchestration）相关接口的契约（约定见 ./contract.ts）。
 * 名称和说明不属于场景版本，可以随时修改；归档的场景不出现在默认列表、不能触发运行，可以恢复，不提供物理删除。
 * 场景版本不可修改：保存、恢复都是追加新版本。
 *
 * 响应里的 `document` 用 OrchestrationDocument：控制面保存时按它解析，读出时再解析一次（升级前保存的版本
 * 由此补上后来新增字段的默认值，例如注释框 `annotations`），满足「响应解析前后相同」的约定。
 */

/**
 * 运行通知的触发条件（GLOSSARY「运行通知」）：仅失败、失败和取消、总是（成功、失败、取消都发）。
 */
export const RunNotificationTrigger = z.enum(["failed", "failed_or_cancelled", "always"]);

/** 卡片标题和附加说明的长度上限（字符数）。 */
export const RUN_NOTIFICATION_TITLE_MAX = 200;
export const RUN_NOTIFICATION_NOTE_MAX = 4000;

/**
 * 场景的运行通知设置（GLOSSARY「运行通知」，ADR 0020）：和名称、说明一样是场景自己的设置，不属于场景版本，
 * 通过更新场景的接口修改，立即生效；运行结束时读取场景当前的设置。
 */
export const RunNotificationSettings = z.object({
	/** 发给哪个飞书机器人（名称）；null 即关闭。机器人可能已被删除，运行结束时记为「未发送」。 */
	bot: z.string().nullable(),
	trigger: RunNotificationTrigger,
	/** 卡片标题；空字符串时用场景名。 */
	title: z.string(),
	/** 附加说明（Markdown，可以 @ 人），放在卡片正文的最前面；空字符串即没有。 */
	note: z.string(),
});

/** 更新运行通知设置的请求：只写要修改的项，其余保持不变。 */
export const RunNotificationChanges = z
	.strictObject({
		bot: FeishuBotName.nullable().optional(),
		trigger: RunNotificationTrigger.optional(),
		title: z.string().trim().max(RUN_NOTIFICATION_TITLE_MAX).optional(),
		note: z.string().trim().max(RUN_NOTIFICATION_NOTE_MAX).optional(),
	})
	.refine((c) => Object.values(c).some((v) => v !== undefined), "没有要修改的运行通知设置");

/** 关注项最多几个，失效的项也占名额。 */
export const FOCUS_ITEMS_MAX = 8;
/** 关注项的名字（场景作者起的）的长度上限（Unicode 字符数）。 */
export const FOCUS_ITEM_TITLE_MAX = 40;

/**
 * 请求里的一个关注项（GLOSSARY「关注项」）：来源节点的 ID，和图表的标题（按标题引用，节点包元信息不给图表加 ID），
 * 以及场景作者起的名字：不写、或者去掉首尾空白后为空，都是没起名，显示时用图表标题。名字只能写一行。
 */
export const FocusItemInput = z.strictObject({
	node_id: z.string().min(1),
	chart: z.string().min(1),
	title: optionalLine(FOCUS_ITEM_TITLE_MAX),
});

const focusItemBase = {
	node_id: z.string(),
	chart: z.string(),
	/** 场景作者起的名字；没起名时没有这个字段，显示时用 `chart`。 */
	title: z.string().optional(),
};

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
export const FocusItemView = z.discriminatedUnion("status", [
	z.object({
		...focusItemBase,
		status: z.literal("ok"),
		/** 图表在最新版本里声明的类型（`stat` 是数值卡，显示成数值，其余照声明画）。 */
		chart_type: ChartDeclaration.shape.type,
	}),
	z.object({
		...focusItemBase,
		status: z.literal("node_missing"),
		last_version: z.number().int().nullable(),
	}),
	z.object({ ...focusItemBase, status: z.literal("chart_missing") }),
]);

/** 关注项最后一次修改：谁、什么时候（控制面时间）、一句话说明改了什么（控制面比较新旧列表生成）。 */
export const FocusEditView = z.object({
	/** 修改人的昵称。 */
	updated_by: z.string(),
	updated_at: Timestamp,
	/** 例如「添加了「TPS」」「把「下单延迟」移到第 6 位」「撤销了移除「TPS」」「复制自「撮合浸泡」」。 */
	summary: z.string(),
});

/** 场景的基本信息：场景列表和场景视图共用，不含需要对照最新版本才能得出的内容。 */
export const OrchestrationBase = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string(),
	/** 最新版本号；0 表示还没有保存过版本。 */
	head_version: z.number().int(),
	created_at: Timestamp,
	/** 归档时间；没有归档时为 null。 */
	archived_at: Timestamp.nullable(),
	run_notification: RunNotificationSettings,
});

export const OrchestrationView = z.object({
	...OrchestrationBase.shape,
	/** 关注项，按作者设定的顺序；每项带它在最新版本里的状态。场景列表不带这个字段。 */
	focus_items: z.array(FocusItemView),
	/** 关注项最后一次修改；从没改过（也没有复制过关注项）时为 null。 */
	focus_edit: FocusEditView.nullable(),
});

/** 编辑起点：最新版本；还没有版本时是只含入口节点的初始文档（number 为 0，作者与时间为 null）。 */
export const OrchestrationHeadView = z.object({
	orchestration_id: z.string(),
	number: z.number().int(),
	author: z.string().nullable(),
	/** 经哪个 AI 编程助手保存；没有版本或没有经助手时为 null。 */
	author_via: z.string().nullable(),
	created_at: Timestamp.nullable(),
	document: OrchestrationDocument,
});

export const VersionSummaryView = z.object({
	number: z.number().int(),
	author: z.string(),
	/** 经哪个 AI 编程助手保存（请求头 `x-sfly-client` 里的 `agent/<名称>`）；没有时为 null。只是标注，不是鉴权。 */
	author_via: z.string().nullable(),
	created_at: Timestamp,
});

/** 一个场景版本的完整内容。 */
export const OrchestrationVersionView = z.object({
	id: z.string(),
	orchestration_id: z.string(),
	number: z.number().int(),
	author: z.string(),
	author_via: z.string().nullable(),
	created_at: Timestamp,
	document: OrchestrationDocument,
});

/**
 * 保存时返回的静态检查警告（@sfly/orchestration 的 documentWarnings）；只提示，不阻止保存。
 * 注释框的警告带 `annotation_id`，指出是哪个注释框；它们也不阻断触发。
 */
export const DocumentWarningView = z.object({
	code: z.string(),
	message: z.string(),
	node_id: z.string().optional(),
	input: z.string().optional(),
	annotation_id: z.string().optional(),
});

export const SavedVersionView = z.object({
	...OrchestrationVersionView.shape,
	warnings: z.array(DocumentWarningView),
});

/** 409 `version_conflict` 的 details：别人在 base_version 之后先保存了新版本（还没有版本时 head 为 null）。 */
export const VersionConflictDetails = z.object({
	base_version: z.number().int(),
	head: VersionSummaryView.nullable(),
});

const RunStatus = z.enum(["running", "success", "failed", "cancelled"]);

/** 节点在一次运行中的状态：任务状态，加上还没有任务记录时的 pending。 */
const NodeRunStatus = z.enum([
	"pending",
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

/** 缩略图用的结构：最新版本（没有版本时是只含入口节点的初始文档）的节点与连线，不含参数与布局。 */
export const OrchestrationStructure = z.object({
	nodes: z.array(
		z.object({
			id: z.string(),
			kind: z.enum([
				"entry",
				"subflow_entry",
				"async",
				"timer",
				"sleep",
				"stop_subflow",
				"feishu_notify",
				"package",
			]),
		}),
	),
	edges: z.array(
		z.object({ from: z.string(), to: z.string(), kind: z.enum(["chain", "dispatch"]) }),
	),
});

/** 场景引用的 Agent；unknown：还没有注册过（从没连接过控制面）。 */
export const ReferencedAgent = z.object({
	name: z.string(),
	/** 场景的默认 Agent。 */
	default: z.boolean(),
	status: z.enum(["online", "offline", "unknown"]),
});

/** 运行前检查里引用的 Agent：在线的 Agent 正在准备环境时，带上开始准备的控制面时间。 */
export const PreflightAgent = ReferencedAgent.extend({
	/** 这次连接发出 Welcome 的控制面时间；已准备好、不在线或没有注册过时为 null（任务派发要等 Agent 准备好）。 */
	preparing_since: Timestamp.nullable(),
});

export const LastRun = z.object({
	id: z.string(),
	status: RunStatus,
	/** 已请求取消、还在等待任务结束与清理（status 仍是 running，界面显示「取消中」）。 */
	cancelling: z.boolean(),
	/** 运行绑定的场景版本号。 */
	version: z.number().int(),
	triggered_by: z.string(),
	started_at: Timestamp,
	ended_at: Timestamp.nullable(),
	/**
	 * 节点 ID → 状态（重试或子流程有多个实例时取最新的一条任务）；最新版本里还没有任务记录的节点为 pending。
	 * 运行绑定的可能是旧版本，所以也可能含最新版本里已经没有的节点。
	 */
	node_states: z.record(z.string(), NodeRunStatus),
});

/** 场景列表里的一项（场景卡片与表格所需的全部数据）。 */
export const OrchestrationSummary = z.object({
	...OrchestrationBase.shape,
	/** 最近一次保存版本的时间；没有版本时为新建时间。 */
	updated_at: Timestamp,
	/** 最新版本的节点数（含入口节点）。 */
	node_count: z.number().int(),
	/** 最新版本的子流程数。 */
	subflow_count: z.number().int(),
	structure: OrchestrationStructure,
	default_agent: z.string().nullable(),
	/** 默认 Agent 在前，其余按名称排序。 */
	agents: z.array(ReferencedAgent),
	/** 最近一次运行；从没运行过时为 null。 */
	last_run: LastRun.nullable(),
});

const IdParams = z.object({ id: z.string().min(1) });
/** 版本号不是整数时与版本不存在一样返回 404（不是 400），所以这里不做数字转换。 */
const VersionParams = z.object({ id: z.string().min(1), number: z.string().min(1) });
const Name = z.string().trim().min(1);

export const ListOrchestrationsQuery = z.object({
	/** 按名称、说明或引用的 Agent 搜索（不区分大小写的子串）。 */
	q: z.string().trim().optional(),
	/** 最近一次运行的状态。 */
	status: RunStatus.optional(),
	/** 引用了这个 Agent（默认 Agent 或节点另选的 Agent）。 */
	agent: z.string().min(1).optional(),
	/** true：只看已归档的场景；默认只列出没有归档的。 */
	archived: z.stringbool().optional(),
});

export const orchestrationsApi = {
	/** 场景列表，按新建时间从新到旧；archived_count 是已归档场景的总数（不受其他筛选影响）。 */
	list: endpoint({
		method: "GET",
		path: "/orchestrations",
		client: true,
		key: ["orchestrations", "list"],
		query: ListOrchestrationsQuery,
		response: z.object({
			orchestrations: z.array(OrchestrationSummary),
			archived_count: z.number().int(),
		}),
	}),
	/** 单个场景（名称、说明、最新版本号、归档时间、运行通知设置、关注项）。 */
	get: endpoint({
		method: "GET",
		path: "/orchestrations/:id",
		client: true,
		key: ["orchestrations", "detail"],
		params: IdParams,
		response: OrchestrationView,
	}),
	/** 编辑起点：最新版本的内容。 */
	head: endpoint({
		method: "GET",
		path: "/orchestrations/:id/head",
		client: true,
		key: ["orchestrations", "head"],
		params: IdParams,
		response: OrchestrationHeadView,
	}),
	/**
	 * 保存（追加）一个版本，返回 201。需要昵称请求头。base_version 是编辑起点的版本号，
	 * 不是最新版本时返回 409 `version_conflict`（details 见 VersionConflictDetails）。
	 * 请求体不符合契约时用更具体的错误码：缺 base_version 返回 400 `base_version_required`，
	 * 其余（文档不合法、base_version 不是非负整数）返回 400 `invalid_document`。
	 *
	 * 响应里的 `warnings` 只提示，不阻止保存。除了文档本身的静态检查，原来可用、对照新版本会失效的运行预设
	 * （GLOSSARY「失效的运行预设」）各有一条，`code` 是 `preset_invalidated`，没有 `node_id`，`message` 写明预设名和原因；
	 * 原来就已失效的预设不重复警告。
	 */
	saveVersion: endpoint({
		method: "POST",
		path: "/orchestrations/:id/versions",
		client: true,
		key: ["orchestrations", "save-version"],
		params: IdParams,
		body: z.object({
			document: OrchestrationDocument,
			base_version: z.number().int().nonnegative(),
		}),
		requestError: ({ body }) =>
			typeof body === "object" && body !== null && Object.hasOwn(body, "base_version")
				? {
						code: "invalid_document",
						message: "document does not match the orchestration schema",
					}
				: {
						code: "base_version_required",
						message: "base_version is required (use 0 for the first version)",
					},
		response: SavedVersionView,
	}),
	/** 版本历史：按版本号从新到旧列出版本号、作者和时间。 */
	versions: endpoint({
		method: "GET",
		path: "/orchestrations/:id/versions",
		client: true,
		key: ["orchestrations", "versions"],
		params: IdParams,
		response: z.object({ versions: z.array(VersionSummaryView) }),
	}),
	/** 某个版本的完整内容（版本不可变）。 */
	version: endpoint({
		method: "GET",
		path: "/orchestrations/:id/versions/:number",
		client: true,
		key: ["orchestrations", "version"],
		params: VersionParams,
		response: OrchestrationVersionView,
	}),
	/**
	 * 恢复历史版本：用它的内容追加一个新版本（不改写历史），返回 201 与保存相同的响应。需要昵称请求头。
	 * 恢复不检查编辑起点：恢复后其他人基于旧版本的保存会得到 409。
	 */
	restoreVersion: endpoint({
		method: "POST",
		path: "/orchestrations/:id/versions/:number/restore",
		client: true,
		key: ["orchestrations", "restore-version"],
		params: VersionParams,
		response: SavedVersionView,
	}),
	/** 新建场景（自带入口节点：还没有版本时编辑起点是只含入口节点的初始文档）。 */
	create: endpoint({
		method: "POST",
		path: "/orchestrations",
		client: true,
		key: ["orchestrations", "create"],
		body: z.strictObject({ name: Name, description: z.string().default("") }),
		response: OrchestrationView,
	}),
	/**
	 * 修改名称、说明、运行通知设置和关注项；不产生新的场景版本，立即生效。
	 *
	 * `focus_items` 是整份替换：给了就用它代替现在的列表（空数组即清空），按列表顺序保存；同时修改时后写的生效，
	 * 不做乐观锁。不合格时返回 400，列表不变：
	 *
	 * - `focus_items_limit`：超过 {@link FOCUS_ITEMS_MAX} 项。已经失效的项也算在内。
	 * - `focus_item_duplicate`：同一个 `(node_id, chart)` 出现了不止一次。
	 * - `focus_item_unknown_chart`：新加入的项引用了最新版本里没有的节点，或者这个节点锁定的节点包版本没有这张图表。
	 *   已经在列表里、后来失效的项允许原样保留（排序、改名都可以）；移除之后再加回去算新加入的。例外是撤销：
	 *   写回上一次修改之前的列表（界面上的「撤销」就是这样做的）算撤销，整份不再检查，所以移除一个已经失效的项之后
	 *   也能撤销回去。撤销之后没有可以再撤销的列表。
	 *
	 * 控制面比较新旧列表，记下最后一次修改（响应里的 `focus_edit`）；写入和现在一样的列表不算修改。
	 */
	update: endpoint({
		method: "PATCH",
		path: "/orchestrations/:id",
		client: true,
		key: ["orchestrations", "update"],
		params: IdParams,
		body: z
			.strictObject({
				name: Name.optional(),
				description: z.string().optional(),
				run_notification: RunNotificationChanges.optional(),
				focus_items: z.array(FocusItemInput).optional(),
			})
			.refine((b) => Object.values(b).some((v) => v !== undefined), "没有要修改的字段"),
		response: OrchestrationView,
	}),
	/**
	 * 复制场景并取新名字：说明、运行通知设置、运行预设（包括 secret 的值）和关注项（包括已经失效的）一起复制，
	 * 源场景最新版本的内容作为第 1 版。有关注项时，副本的关注项最后修改记为复制的人，说明写「复制自「源场景名」」。
	 * 联调副本也走这个接口。
	 */
	copy: endpoint({
		method: "POST",
		path: "/orchestrations/:id/copy",
		client: true,
		key: ["orchestrations", "copy"],
		params: IdParams,
		body: z.strictObject({ name: Name }),
		response: OrchestrationView,
	}),
	/** 归档；有运行中的运行时返回 409 run_in_progress。 */
	archive: endpoint({
		method: "POST",
		path: "/orchestrations/:id/archive",
		client: true,
		key: ["orchestrations", "archive"],
		params: IdParams,
		response: OrchestrationView,
	}),
	/** 恢复已归档的场景。 */
	unarchive: endpoint({
		method: "POST",
		path: "/orchestrations/:id/unarchive",
		client: true,
		key: ["orchestrations", "unarchive"],
		params: IdParams,
		response: OrchestrationView,
	}),
};

export type OrchestrationBase = z.infer<typeof OrchestrationBase>;
export type OrchestrationView = z.infer<typeof OrchestrationView>;
export type FocusItemInput = z.output<typeof FocusItemInput>;
export type FocusItemView = z.infer<typeof FocusItemView>;
export type FocusEditView = z.infer<typeof FocusEditView>;
export type RunNotificationSettings = z.infer<typeof RunNotificationSettings>;
export type RunNotificationChanges = z.infer<typeof RunNotificationChanges>;
export type RunNotificationTrigger = z.infer<typeof RunNotificationTrigger>;
export type OrchestrationSummary = z.infer<typeof OrchestrationSummary>;
export type OrchestrationStructure = z.infer<typeof OrchestrationStructure>;
export type ReferencedAgent = z.infer<typeof ReferencedAgent>;
export type PreflightAgent = z.infer<typeof PreflightAgent>;
export type LastRun = z.infer<typeof LastRun>;
export type LastRunNodeStatus = z.infer<typeof NodeRunStatus>;
export type OrchestrationHeadView = z.infer<typeof OrchestrationHeadView>;
export type VersionSummaryView = z.infer<typeof VersionSummaryView>;
export type DocumentWarningView = z.infer<typeof DocumentWarningView>;
export type OrchestrationVersionView = z.infer<typeof OrchestrationVersionView>;
export type SavedVersionView = z.infer<typeof SavedVersionView>;
export type VersionConflictDetails = z.infer<typeof VersionConflictDetails>;
