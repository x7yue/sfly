import { z } from "zod";
import { endpoint, Timestamp } from "./contract.js";

/**
 * 场景（代码与路径里沿用 orchestration）相关接口的契约（约定见 ./contract.ts）。
 * 名称和说明不属于场景版本，可以随时修改；归档的场景不出现在默认列表、不能触发运行，可以恢复，不提供物理删除。
 */

export const OrchestrationView = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string(),
	/** 最新版本号；0 表示还没有保存过版本。 */
	head_version: z.number().int(),
	created_at: Timestamp,
	/** 归档时间；没有归档时为 null。 */
	archived_at: Timestamp.nullable(),
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
]);

/** 缩略图用的结构：最新版本（没有版本时是只含入口节点的初始文档）的节点与连线，不含参数与布局。 */
export const OrchestrationStructure = z.object({
	nodes: z.array(
		z.object({
			id: z.string(),
			kind: z.enum(["entry", "subflow_entry", "async", "timer", "sleep", "package"]),
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

const IdParams = z.object({ id: z.string() });
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
	get: endpoint({
		method: "GET",
		path: "/orchestrations/:id",
		key: ["orchestrations", "detail"],
		params: IdParams,
		response: OrchestrationView,
	}),
	/** 新建场景（自带入口节点：还没有版本时编辑起点是只含入口节点的初始文档）。 */
	create: endpoint({
		method: "POST",
		path: "/orchestrations",
		key: ["orchestrations", "create"],
		body: z.strictObject({ name: Name, description: z.string().default("") }),
		response: OrchestrationView,
	}),
	/** 修改名称和说明；不产生新的场景版本。 */
	update: endpoint({
		method: "PATCH",
		path: "/orchestrations/:id",
		key: ["orchestrations", "update"],
		params: IdParams,
		body: z
			.strictObject({ name: Name.optional(), description: z.string().optional() })
			.refine((b) => b.name !== undefined || b.description !== undefined, "没有要修改的字段"),
		response: OrchestrationView,
	}),
	/** 复制场景并取新名字：说明一起复制，源场景最新版本的内容作为第 1 版。 */
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
export type OrchestrationSummary = z.infer<typeof OrchestrationSummary>;
export type OrchestrationStructure = z.infer<typeof OrchestrationStructure>;
export type ReferencedAgent = z.infer<typeof ReferencedAgent>;
export type LastRun = z.infer<typeof LastRun>;
export type LastRunNodeStatus = z.infer<typeof NodeRunStatus>;
