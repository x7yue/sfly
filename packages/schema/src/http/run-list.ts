import { z } from "zod";
import { endpoint, Timestamp } from "./contract.js";
import { RunListPreset } from "./runs.js";

/**
 * 跨场景的运行列表（运行记录页，约定见 ./contract.ts）。每一项带上各链的进度摘要、
 * 进行中的节点与失败的链，列表页不必逐个读取运行视图。节点状态与运行视图（GET /runs/:id）一致。
 */

const RUN_STATUSES = ["running", "success", "failed", "cancelled"] as const;

/** 查询参数：空字符串等于没给。 */
const blankAsMissing = <S extends z.ZodType>(schema: S) =>
	z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

export const RunListQuery = z.object({
	/** 只要这个状态的运行。 */
	status: blankAsMissing(z.enum(RUN_STATUSES)),
	/** 只要这个场景的运行。 */
	orchestration_id: blankAsMissing(z.uuid()),
	/** 运行编号前缀或触发人（包含，不区分大小写）。 */
	q: blankAsMissing(z.string().trim().max(200)),
	limit: z.coerce.number().int().min(1).max(500).default(200),
});

/** 链实例的进度：节点按链上的顺序。 */
export const RunListChain = z.object({
	id: z.string(),
	/** 链起点节点 ID（主链是入口节点，子流程是子流程入口节点）。 */
	chain_id: z.string(),
	/** 子流程实例（不是主链）。 */
	subflow: z.boolean(),
	/**
	 * 子流程名称（与运行视图里链实例的 name 相同：没有名称字段的旧版本为子流程入口的节点 ID，名称为空时为空字符串），
	 * 取自运行绑定的场景版本；主链不给。
	 */
	subflow_name: z.string().optional(),
	status: z.enum(RUN_STATUSES),
	nodes: z.array(z.object({ node_id: z.string(), status: z.string() })),
});

/** 进行中的节点（排队中、准备中、执行中、等待中），按链与链上的顺序。 */
export const RunListActiveNode = z.object({
	chain_instance_id: z.string(),
	node_id: z.string(),
	/** 节点的显示名称（子流程入口节点是子流程名称），取自运行绑定的场景版本；没有时不给。 */
	display_name: z.string().optional(),
	status: z.string(),
	/** 最后一次尝试的尝试号（从 1 开始）。 */
	attempt: z.number().int(),
	/** 任务所在的 Agent（排队中的任务是它在等的 Agent）；不在 Agent 上执行的节点（等待节点、停止子流程节点）为 null。 */
	agent: z.string().nullable(),
	/** 最后一次尝试开始的时间（等待节点是开始等待的时间）；还没开始执行（排队中、准备中）时为 null。 */
	started_at: Timestamp.nullable(),
	/** 等待节点（定时 / Sleep）的唤醒时间；其他节点为 null。 */
	wake_at: Timestamp.nullable(),
	/** 最新进度；没有上报过时为 null。 */
	progress: z.object({ current: z.number(), total: z.number().nullable() }).nullable(),
});

/** 失败的链实例：链失败或链上有节点失败（子流程失败时主链可能还在运行）。 */
export const RunListFailure = z.object({
	chain_instance_id: z.string(),
	chain_id: z.string(),
	subflow: z.boolean(),
	/**
	 * 子流程名称（与运行视图里链实例的 name 相同：没有名称字段的旧版本为子流程入口的节点 ID，名称为空时为空字符串），
	 * 取自运行绑定的场景版本；主链不给。
	 */
	subflow_name: z.string().optional(),
	/** 链上第一个失败的节点（按失败的先后，GLOSSARY「第一个失败的节点」）；没有失败节点时（例如参数校验失败）为 null。 */
	node_id: z.string().nullable(),
	/** 失败节点的显示名称（子流程入口节点是子流程名称），取自运行绑定的场景版本；没有时不给。 */
	display_name: z.string().optional(),
});

export const RunListItem = z.object({
	id: z.string(),
	orchestration_id: z.string(),
	orchestration_name: z.string(),
	orchestration_version: z.number().int(),
	status: z.enum(RUN_STATUSES),
	/** 已请求取消、正在清理（运行状态仍是 running）。 */
	cancelling: z.boolean(),
	triggered_by: z.string(),
	/** 经哪个 AI 编程助手触发；没有时为 null。 */
	triggered_via: z.string().nullable(),
	/** 触发时选用的运行预设；没有用预设时为 null。 */
	preset: RunListPreset.nullable(),
	started_at: Timestamp,
	ended_at: Timestamp.nullable(),
	/** 按深度、开始时间排序。 */
	chains: z.array(RunListChain),
	active_nodes: z.array(RunListActiveNode),
	/**
	 * 失败的链实例，按失败的先后：有失败节点的链按它第一个失败的节点的结束时间（同一时刻按链的顺序），所以第一项是这次运行
	 * 「第一个失败的节点」所在的链（和控制台、运行监控、运行通知是同一个节点）；链失败却没有失败节点的排在最后。
	 */
	failures: z.array(RunListFailure),
});

export const runListApi = {
	/**
	 * 所有场景的运行，按开始时间从新到旧（最多 limit 条）。counts 是按场景、关键字筛选后
	 * （不按状态）各状态的运行数，用于状态筛选上的计数。
	 */
	list: endpoint({
		method: "GET",
		path: "/runs",
		client: true,
		key: ["runs", "list"],
		query: RunListQuery,
		response: z.object({
			runs: z.array(RunListItem),
			counts: z.object({
				running: z.number().int(),
				success: z.number().int(),
				failed: z.number().int(),
				cancelled: z.number().int(),
			}),
		}),
	}),
};

export type RunListQuery = z.input<typeof RunListQuery>;
export type RunListChain = z.infer<typeof RunListChain>;
export type RunListActiveNode = z.infer<typeof RunListActiveNode>;
export type RunListFailure = z.infer<typeof RunListFailure>;
export type RunListItem = z.infer<typeof RunListItem>;
