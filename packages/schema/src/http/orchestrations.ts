import { z } from "zod";
import { OrchestrationDocument } from "../orchestration-document.js";
import { endpoint, Timestamp } from "./contract.js";
import { FeishuBotName } from "./feishu-bots.js";

/**
 * 场景（代码与路径里沿用 orchestration）相关接口的契约（约定见 ./contract.ts）。
 * 名称和说明不属于场景版本，可以随时修改；归档的场景不出现在默认列表、不能触发运行，可以恢复，不提供物理删除。
 * 场景版本不可修改：保存、恢复都是追加新版本。
 *
 * 响应里的 `document` 用 OrchestrationDocument：控制面保存时已按它解析（默认值都已补齐），
 * 存储的文档再解析一次不会改变，满足「响应解析前后相同」的约定。
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

export const OrchestrationView = z.object({
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

/** 保存时返回的静态检查警告（@sfly/orchestration 的 documentWarnings）；只提示，不阻止保存。 */
export const DocumentWarningView = z.object({
	code: z.string(),
	message: z.string(),
	node_id: z.string().optional(),
	input: z.string().optional(),
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
	...OrchestrationView.shape,
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
		key: ["orchestrations", "list"],
		query: ListOrchestrationsQuery,
		response: z.object({
			orchestrations: z.array(OrchestrationSummary),
			archived_count: z.number().int(),
		}),
	}),
	/** 单个场景（名称、说明、最新版本号、归档时间）。 */
	get: endpoint({
		method: "GET",
		path: "/orchestrations/:id",
		key: ["orchestrations", "detail"],
		params: IdParams,
		response: OrchestrationView,
	}),
	/** 编辑起点：最新版本的内容。 */
	head: endpoint({
		method: "GET",
		path: "/orchestrations/:id/head",
		key: ["orchestrations", "head"],
		params: IdParams,
		response: OrchestrationHeadView,
	}),
	/**
	 * 保存（追加）一个版本，返回 201。需要昵称请求头。base_version 是编辑起点的版本号，
	 * 不是最新版本时返回 409 `version_conflict`（details 见 VersionConflictDetails）。
	 * 请求体不符合契约时用更具体的错误码：缺 base_version 返回 400 `base_version_required`，
	 * 其余（文档不合法、base_version 不是非负整数）返回 400 `invalid_document`。
	 */
	saveVersion: endpoint({
		method: "POST",
		path: "/orchestrations/:id/versions",
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
		key: ["orchestrations", "versions"],
		params: IdParams,
		response: z.object({ versions: z.array(VersionSummaryView) }),
	}),
	/** 某个版本的完整内容（版本不可变）。 */
	version: endpoint({
		method: "GET",
		path: "/orchestrations/:id/versions/:number",
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
		key: ["orchestrations", "restore-version"],
		params: VersionParams,
		response: SavedVersionView,
	}),
	/** 新建场景（自带入口节点：还没有版本时编辑起点是只含入口节点的初始文档）。 */
	create: endpoint({
		method: "POST",
		path: "/orchestrations",
		key: ["orchestrations", "create"],
		body: z.strictObject({ name: Name, description: z.string().default("") }),
		response: OrchestrationView,
	}),
	/** 修改名称、说明和运行通知设置；不产生新的场景版本，立即生效。 */
	update: endpoint({
		method: "PATCH",
		path: "/orchestrations/:id",
		key: ["orchestrations", "update"],
		params: IdParams,
		body: z
			.strictObject({
				name: Name.optional(),
				description: z.string().optional(),
				run_notification: RunNotificationChanges.optional(),
			})
			.refine(
				(b) =>
					b.name !== undefined || b.description !== undefined || b.run_notification !== undefined,
				"没有要修改的字段",
			),
		response: OrchestrationView,
	}),
	/** 复制场景并取新名字：说明和运行通知设置一起复制，源场景最新版本的内容作为第 1 版。 */
	copy: endpoint({
		method: "POST",
		path: "/orchestrations/:id/copy",
		key: ["orchestrations", "copy"],
		params: IdParams,
		body: z.strictObject({ name: Name }),
		response: OrchestrationView,
	}),
	/** 归档；有运行中的运行时返回 409 run_in_progress。 */
	archive: endpoint({
		method: "POST",
		path: "/orchestrations/:id/archive",
		key: ["orchestrations", "archive"],
		params: IdParams,
		response: OrchestrationView,
	}),
	/** 恢复已归档的场景。 */
	unarchive: endpoint({
		method: "POST",
		path: "/orchestrations/:id/unarchive",
		key: ["orchestrations", "unarchive"],
		params: IdParams,
		response: OrchestrationView,
	}),
};

export type OrchestrationView = z.infer<typeof OrchestrationView>;
export type RunNotificationSettings = z.infer<typeof RunNotificationSettings>;
export type RunNotificationChanges = z.infer<typeof RunNotificationChanges>;
export type RunNotificationTrigger = z.infer<typeof RunNotificationTrigger>;
export type OrchestrationSummary = z.infer<typeof OrchestrationSummary>;
export type OrchestrationStructure = z.infer<typeof OrchestrationStructure>;
export type ReferencedAgent = z.infer<typeof ReferencedAgent>;
export type LastRun = z.infer<typeof LastRun>;
export type LastRunNodeStatus = z.infer<typeof NodeRunStatus>;
export type OrchestrationHeadView = z.infer<typeof OrchestrationHeadView>;
export type VersionSummaryView = z.infer<typeof VersionSummaryView>;
export type DocumentWarningView = z.infer<typeof DocumentWarningView>;
export type OrchestrationVersionView = z.infer<typeof OrchestrationVersionView>;
export type SavedVersionView = z.infer<typeof SavedVersionView>;
export type VersionConflictDetails = z.infer<typeof VersionConflictDetails>;
