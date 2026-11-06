import { z } from "zod";
import { endpoint, Timestamp } from "./contract.js";

/** Agent 管理相关接口的契约（约定见 ./contract.ts）。 */

export const InstalledPackageView = z.object({ name: z.string(), version: z.string() });

/** 最近一次节点包安装状态（Agent 上报 InstallStatus）。 */
export const InstallProgressView = z.object({
	package: z.string(),
	version: z.string(),
	state: z.enum(["installing", "installed", "failed"]),
	task_id: z.string(),
});

/** Agent 上以开发模式（sfly dev）加载的节点包；metadata 是加载时扫描出的元信息，未经发布校验。 */
export const DevPackageView = z.object({
	name: z.string(),
	source: z.string(),
	metadata: z.record(z.string(), z.unknown()).nullable(),
});

/** 派发给 Agent、还没结束的任务。 */
export const RunningTaskView = z.object({
	task_id: z.string(),
	run_id: z.string(),
	orchestration_id: z.string(),
	node_id: z.string(),
	attempt: z.number().int(),
	/** dispatched：下载、安装、启动中；running：执行器已启动。 */
	status: z.enum(["dispatched", "running"]),
	/** 执行器启动的时间；派发阶段为 null。 */
	started_at: Timestamp.nullable(),
});

/**
 * Agent 的更新状态（ADR 0014，Agent 在 Heartbeat 中上报）：none 不需要更新；downloading 下载、校验新版本；
 * waiting_for_tasks 等手上的任务结束（remaining_tasks）；replacing 替换并重新执行；failed 更新失败（reason）；
 * manual_upgrade_required 不能自更新、需要手动升级（reason）。
 */
export const AgentUpdateState = z.enum([
	"none",
	"downloading",
	"waiting_for_tasks",
	"replacing",
	"failed",
	"manual_upgrade_required",
]);

export const AgentUpdateView = z.object({
	state: AgentUpdateState,
	/** waiting_for_tasks 时还要等的任务数，其余状态为 0。 */
	remaining_tasks: z.number().int(),
	/** failed / manual_upgrade_required 的原因，其余状态为空串。 */
	reason: z.string(),
});

export const AgentView = z.object({
	name: z.string(),
	status: z.enum(["online", "offline"]),
	info: z.object({
		agent_version: z.string(),
		os: z.string(),
		arch: z.string(),
		slots: z.number().int(),
		installed_packages: z.array(InstalledPackageView),
	}),
	/** 在线时是本次连接（或最近一次上报）的时间，离线时是最后在线的时间。 */
	last_seen_at: Timestamp,
	/** Agent 共享 venv 中已安装的节点包。 */
	installed_packages: z.array(InstalledPackageView),
	/** 本次连接还没有安装过节点包时为 null。 */
	install: InstallProgressView.nullable(),
	dev_packages: z.array(DevPackageView),
	/** 按派发顺序排列；长度即占用的槽位数。 */
	running_tasks: z.array(RunningTaskView),
	/**
	 * Agent 版本与控制面版本（列表响应的 control_plane_version）不一致：控制面不给它派新任务（ADR 0014），
	 * 它手上的任务照常跑完。按最近一次连接上报的版本判断。
	 */
	version_mismatch: z.boolean(),
	/** 最近一次 Heartbeat 上报的更新状态；本次连接还没上报过（或旧版本 Agent 不上报）时为 none。 */
	update: AgentUpdateView,
	/** 有多少个场景引用这个 Agent（最新版本里的默认 Agent 或节点另选的 Agent）。 */
	referencing_orchestrations: z.number().int(),
});

export const agentsApi = {
	/** 全部注册过的 Agent，按名称排序。 */
	list: endpoint({
		method: "GET",
		path: "/agents",
		key: ["agents", "list"],
		response: z.object({
			agents: z.array(AgentView),
			/** 控制面版本，也就是 Agent 的目标版本。 */
			control_plane_version: z.string(),
		}),
	}),
	/**
	 * 立即更新（ADR 0014）：让版本不一致的在线 Agent 不再等手上的任务跑完。这些任务立即以 agent_lost 失败、按重试配置重新排队
	 * （Agent 更新后重新连上再派发），Agent 按取消流程终止它们后立即替换自己。返回被终止的任务。
	 * Agent 不存在 404 `not_found`；不在线 409 `agent_offline`；版本一致 409 `version_matches`；
	 * 上报了需要手动升级 409 `manual_upgrade_required`（它不会自更新，终止任务没有意义）。
	 */
	updateNow: endpoint({
		method: "POST",
		path: "/agents/:name/update-now",
		key: ["agents", "update-now"],
		params: z.object({ name: z.string().min(1) }),
		response: z.object({ terminated_tasks: z.array(RunningTaskView) }),
	}),
};

export type AgentView = z.infer<typeof AgentView>;
export type AgentUpdateState = z.infer<typeof AgentUpdateState>;
export type AgentUpdateView = z.infer<typeof AgentUpdateView>;
export type DevPackageView = z.infer<typeof DevPackageView>;
export type RunningTaskView = z.infer<typeof RunningTaskView>;
