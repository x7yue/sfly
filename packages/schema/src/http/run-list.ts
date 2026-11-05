import { z } from "zod";
import { endpoint, Timestamp } from "./contract.js";

/**
 * 跨场景的运行列表（运行记录页，约定见 ./contract.ts）。每一项带上各链的进度摘要、
 * 正在执行的节点与失败的链，列表页不必逐个读取运行视图。节点状态与运行视图（GET /runs/:id）一致。
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
	status: z.enum(RUN_STATUSES),
	nodes: z.array(z.object({ node_id: z.string(), status: z.string() })),
});

/** 正在执行的节点（排队、派发中、执行中、等待唤醒），按链与链上的顺序。 */
export const RunListActiveNode = z.object({
	chain_instance_id: z.string(),
	node_id: z.string(),
	status: z.string(),
	/** 最新进度；没有上报过时为 null。 */
	progress: z.object({ current: z.number(), total: z.number().nullable() }).nullable(),
});

/** 失败的链实例：链失败或链上有节点失败（子流程失败时主链可能还在运行）。 */
export const RunListFailure = z.object({
	chain_instance_id: z.string(),
	chain_id: z.string(),
	subflow: z.boolean(),
	/** 链上第一个失败的节点；没有失败节点时（例如参数校验失败）为 null。 */
	node_id: z.string().nullable(),
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
	started_at: Timestamp,
	ended_at: Timestamp.nullable(),
	/** 按深度、开始时间排序。 */
	chains: z.array(RunListChain),
	active_nodes: z.array(RunListActiveNode),
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
