import { z } from "zod";
import { ClockOffsetView } from "./clock-offset.js";
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

/** 一项 Agent 能力（ADR 0019）：Agent 自身提供、节点在执行中通过 SDK 调用的一组操作。 */
export const CapabilityView = z.object({
	/** 能力名，例如 files。 */
	name: z.string(),
	/** 能力的版本，从 1 开始；新增操作或改变行为时加 1。 */
	version: z.number().int(),
});

/** 其它 Agent 连接这台 Agent、调用它的能力用的地址（ADR 0019），按最近一次连接上报的。 */
export const AgentEndpointView = z.object({
	/**
	 * 对外地址（IP 地址或主机名）：安装时显式配置的，没有配置时是控制面看到的连接来源地址。
	 * 早于这个字段注册、之后没有再连接过的 Agent 为空串。
	 */
	address: z.string(),
	/** configured：安装时显式配置的；connection：控制面看到的连接来源地址。 */
	address_source: z.enum(["configured", "connection"]),
	/** 监听的端口；不监听端口的旧版本 Agent 为 null。 */
	port: z.number().int().nullable(),
	/**
	 * 这台 Agent 的能力不能被其它 Agent 调用的原因（例如端口被占用、旧版本 Agent 不监听端口）；可以调用时为 null。
	 * 不影响它执行任务。
	 */
	unavailable_reason: z.string().nullable(),
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
	/**
	 * 在线 Agent 正在准备环境（收到 Welcome 之后、第一次心跳之前，不接任务）时，这次连接发出 Welcome 的控制面时间（ADR 0018）；
	 * 已准备好或离线时为 null。只记在控制面内存里，跟着连接走。
	 */
	preparing_since: Timestamp.nullable(),
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
	/**
	 * 最近一次 Hello 或 Heartbeat 测得的时钟偏差（ADR 0018）；离线时是断开前最后一次测得的。
	 * 未知时为 null：本次（或最近一次）连接的 Agent 是不上报时间的旧版本。
	 */
	clock_offset: ClockOffsetView.nullable(),
	/** 有多少个场景引用这个 Agent（最新版本里的默认 Agent 或节点另选的 Agent）。 */
	referencing_orchestrations: z.number().int(),
	/** 支持的 Agent 能力及版本，按上报的顺序；不上报能力的旧版本 Agent 为空。 */
	capabilities: z.array(CapabilityView),
	endpoint: AgentEndpointView,
});

export const agentsApi = {
	/** 全部注册过的 Agent，按名称排序。 */
	list: endpoint({
		method: "GET",
		path: "/agents",
		client: true,
		key: ["agents", "list"],
		response: z.object({
			agents: z.array(AgentView),
			/** 控制面版本，也就是 Agent 的目标版本。 */
			control_plane_version: z.string(),
		}),
	}),
	/**
	 * 立即更新（ADR 0014）：让正在更新（下载中或等待任务结束）的在线 Agent 不再等手上的任务跑完。这些任务立即以 agent_lost 失败、按重试配置重新排队
	 * （Agent 更新后重新连上再派发），Agent 按取消流程终止它们后立即替换自己。返回被终止的任务。
	 * Agent 不存在 404 `not_found`；不在线 409 `agent_offline`；版本一致 409 `version_matches`；
	 * 上报了需要手动升级 409 `manual_upgrade_required`（它不会自更新，终止任务没有意义）；
	 * 不在更新流程中（更新失败、正在替换、没有上报更新状态的旧 Agent）409 `not_updating`。
	 */
	updateNow: endpoint({
		method: "POST",
		path: "/agents/:name/update-now",
		client: true,
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
export type CapabilityView = z.infer<typeof CapabilityView>;
export type AgentEndpointView = z.infer<typeof AgentEndpointView>;
