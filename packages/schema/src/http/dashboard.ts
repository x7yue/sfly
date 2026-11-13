import { z } from "zod";
import { endpoint, Timestamp } from "./contract.js";

/**
 * 控制台统计接口的契约（约定见 ./contract.ts）。统计窗口是「最近 24 小时」：
 * [generated_at − 24h, generated_at]，按运行（或链实例）的结束时间归入窗口与按小时的桶。
 */

/** 一次运行（或链）的结果计数。 */
const Outcomes = {
	success: z.number().int(),
	failed: z.number().int(),
	cancelled: z.number().int(),
};

/** 趋势里的一小时：[start, start + 1h) 内结束的运行数（恰好在 generated_at 结束的归入最后一个桶）。 */
export const DashboardHour = z.object({ start: Timestamp, ...Outcomes });

export const DashboardRunStats = z.object({
	/** 正在运行的运行数（含取消中的）。 */
	running: z.number().int(),
	/** 正在运行的链实例数（主链与子流程）。 */
	running_chains: z.number().int(),
	/** 已派发给 Agent、还没结束的任务数（派发中与执行中）。 */
	running_tasks: z.number().int(),
	/** 排队等待 Agent 的任务数。 */
	queued_tasks: z.number().int(),
	/** 窗口内结束的运行，按结果计数。 */
	...Outcomes,
	/** 窗口内失败的子流程实例数（不论所在运行是否已结束）。 */
	failed_subflows: z.number().int(),
	/** 成功率 = 成功 / 结束的运行数（0–1）；窗口内没有结束的运行时为 null。 */
	success_rate: z.number().nullable(),
	/** 前一个 24 小时的成功率，用于对比；没有结束的运行时为 null。 */
	previous_success_rate: z.number().nullable(),
});

/** 运行中的链实例：节点按链上的顺序，状态与运行视图一致（pending、queued、running、success…）。 */
export const DashboardChain = z.object({
	id: z.string(),
	chain_id: z.string(),
	/** 子流程实例（不是主链）。 */
	subflow: z.boolean(),
	status: z.string(),
	nodes: z.array(z.object({ node_id: z.string(), status: z.string() })),
});

export const DashboardRunningRun = z.object({
	id: z.string(),
	orchestration_id: z.string(),
	orchestration_name: z.string(),
	orchestration_version: z.number().int(),
	triggered_by: z.string(),
	started_at: Timestamp,
	/** 已请求取消、正在清理（运行状态仍是 running）。 */
	cancelling: z.boolean(),
	chains: z.array(DashboardChain),
});

/** 最近失败的一条：一个失败的链实例（主链失败即运行失败；子流程失败单独一条）。 */
export const DashboardFailure = z.object({
	run_id: z.string(),
	orchestration_id: z.string(),
	orchestration_name: z.string(),
	/** 所在运行的当前状态（子流程失败时主链可能还在运行）。 */
	run_status: z.string(),
	chain_instance_id: z.string(),
	chain_id: z.string(),
	subflow: z.boolean(),
	/** 最先失败的节点（最后一次尝试失败）；没有失败节点时（例如校验失败）为 null。 */
	node_id: z.string().nullable(),
	error: z.object({ kind: z.string(), message: z.string() }).nullable(),
	/** 链实例结束的时间。 */
	failed_at: Timestamp,
});

export const DashboardAgent = z.object({
	name: z.string(),
	status: z.enum(["online", "offline"]),
	slots: z.number().int(),
	/** 占用的槽位数（派发中与执行中的任务）。 */
	used_slots: z.number().int(),
	/** 正在安装的节点包；没有在安装时为 null。 */
	installing: z.object({ package: z.string(), version: z.string() }).nullable(),
	last_seen_at: Timestamp,
});

export const DashboardAgentStats = z.object({
	online: z.number().int(),
	offline: z.number().int(),
	/** 在线 Agent 的槽位合计与占用。 */
	slots: z.number().int(),
	used_slots: z.number().int(),
	/** 全部注册过的 Agent，按名称排序。 */
	list: z.array(DashboardAgent),
});

export const DashboardPackage = z.object({
	name: z.string(),
	version: z.string(),
	published_at: Timestamp,
	/** 有多少个场景的最新版本锁定了这个版本。 */
	locked_orchestrations: z.number().int(),
});

export const DashboardView = z.object({
	/** 统计的时刻（控制面时钟），窗口的终点。 */
	generated_at: Timestamp,
	runs: DashboardRunStats,
	/** 24 个小时桶，从旧到新；最后一个桶以 generated_at 为终点。 */
	hourly: z.array(DashboardHour),
	/** 正在运行的运行，按开始时间从新到旧。 */
	running_runs: z.array(DashboardRunningRun),
	/** 窗口内失败的链实例，按失败时间从新到旧（最多 10 条）。 */
	recent_failures: z.array(DashboardFailure),
	agents: DashboardAgentStats,
	/** 最近发布的节点包版本，从新到旧（最多 5 个）。 */
	recent_packages: z.array(DashboardPackage),
});

export const dashboardApi = {
	/** 控制台统计（最近 24 小时）。 */
	get: endpoint({
		method: "GET",
		path: "/dashboard",
		client: true,
		key: ["dashboard", "get"],
		response: DashboardView,
	}),
};

export type DashboardView = z.infer<typeof DashboardView>;
export type DashboardRunningRun = z.infer<typeof DashboardRunningRun>;
export type DashboardChain = z.infer<typeof DashboardChain>;
export type DashboardFailure = z.infer<typeof DashboardFailure>;
export type DashboardAgent = z.infer<typeof DashboardAgent>;
export type DashboardHour = z.infer<typeof DashboardHour>;
