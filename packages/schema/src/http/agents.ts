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
	/** 有多少个场景引用这个 Agent（最新版本里的默认 Agent 或节点另选的 Agent）。 */
	referencing_orchestrations: z.number().int(),
});

export const agentsApi = {
	/** 全部注册过的 Agent，按名称排序。 */
	list: endpoint({
		method: "GET",
		path: "/agents",
		key: ["agents", "list"],
		response: z.object({ agents: z.array(AgentView) }),
	}),
};

export type AgentView = z.infer<typeof AgentView>;
export type DevPackageView = z.infer<typeof DevPackageView>;
export type RunningTaskView = z.infer<typeof RunningTaskView>;
