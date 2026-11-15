import { z } from "zod";
import { endpoint, Timestamp } from "./contract.js";

/**
 * 控制台统计接口的契约（约定见 ./contract.ts）。统计窗口是「最近 24 小时」：
 * [generated_at − 24h, generated_at]，按运行（或链实例）的结束时间归入窗口。
 */

/** 一次运行（或链）的结果计数。 */
const Outcomes = {
	success: z.number().int(),
	failed: z.number().int(),
	cancelled: z.number().int(),
};

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
});

/** 运行中的链实例：节点按链上的顺序，状态与运行视图一致（pending、queued、running、success…）。 */
export const DashboardChain = z.object({
	id: z.string(),
	chain_id: z.string(),
	/** 子流程实例（不是主链）。 */
	subflow: z.boolean(),
	/**
	 * 子流程名称（与运行视图里链实例的 name 相同：没有名称字段的旧版本为子流程入口的节点 ID，名称为空时为空字符串），
	 * 取自运行绑定的场景版本；主链不给。
	 */
	subflow_name: z.string().optional(),
	status: z.string(),
	nodes: z.array(
		z.object({
			node_id: z.string(),
			/** 节点的显示名称（子流程入口节点是子流程名称），取自运行绑定的场景版本；没有时不给。 */
			display_name: z.string().optional(),
			status: z.string(),
		}),
	),
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
	/**
	 * 子流程名称（与运行视图里链实例的 name 相同：没有名称字段的旧版本为子流程入口的节点 ID，名称为空时为空字符串），
	 * 取自运行绑定的场景版本；主链不给。
	 */
	subflow_name: z.string().optional(),
	/** 最先失败的节点（最后一次尝试失败）；没有失败节点时（例如校验失败）为 null。 */
	node_id: z.string().nullable(),
	/** 失败节点的显示名称（子流程入口节点是子流程名称），取自运行绑定的场景版本；没有时不给。 */
	display_name: z.string().optional(),
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

/**
 * 「开始使用」的四步（外壳页方案第 5 节）：各自是否完成，以及写在步骤上的事实。四步互不依赖，各自从现有数据判断；
 * 出现第一个运行（`run.done`）之后控制台不再显示这个面板。
 */
export const DashboardSetup = z.object({
	/** 接入一台 Agent：有在线的 Agent 就算完成。 */
	agent: z.object({
		done: z.boolean(),
		/** 在线的 Agent 数。 */
		online: z.number().int(),
		/** 名称排在最前的在线 Agent；没有在线的为 null。 */
		name: z.string().nullable(),
	}),
	/** 发布节点包：已经发布过任何一个版本就算完成。 */
	package: z.object({
		done: z.boolean(),
		/** 已发布的节点包个数（按包名，不计版本数）。 */
		count: z.number().int(),
		/** 最近发布的版本；还没有为 null。 */
		latest: z.object({ name: z.string(), version: z.string() }).nullable(),
	}),
	/** 新建场景：有没有归档的场景就算完成。 */
	scenario: z.object({
		done: z.boolean(),
		/** 没有归档的场景数。 */
		count: z.number().int(),
		/** 最近新建的、没有归档的场景名称；没有为 null。 */
		name: z.string().nullable(),
	}),
	/** 触发第一次运行：有过任何一个运行（不论结果、不论场景是否已归档）就算完成。 */
	run: z.object({ done: z.boolean() }),
});

export const DashboardView = z.object({
	/** 统计的时刻（控制面时钟），窗口的终点。 */
	generated_at: Timestamp,
	runs: DashboardRunStats,
	/** 正在运行的运行，按开始时间从新到旧。 */
	running_runs: z.array(DashboardRunningRun),
	/** 窗口内失败的链实例，按失败时间从新到旧（最多 10 条）。 */
	recent_failures: z.array(DashboardFailure),
	agents: DashboardAgentStats,
	setup: DashboardSetup,
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

export type DashboardSetup = z.infer<typeof DashboardSetup>;
export type DashboardView = z.infer<typeof DashboardView>;
export type DashboardRunningRun = z.infer<typeof DashboardRunningRun>;
export type DashboardChain = z.infer<typeof DashboardChain>;
export type DashboardFailure = z.infer<typeof DashboardFailure>;
export type DashboardAgent = z.infer<typeof DashboardAgent>;
