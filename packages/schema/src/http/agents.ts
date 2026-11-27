import { z } from "zod";
import { AGENT_NAME_MAX_LENGTH, nameProblem, nameRefinement } from "../text-safety.js";
import { CurrentAction } from "./actions.js";
import { ClockOffsetView } from "./clock-offset.js";
import { endpoint, Timestamp } from "./contract.js";
import { TaskProgressView } from "./runs.js";

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

/** 占着或等着这台 Agent 槽位的任务：哪个场景的哪个运行、哪条链上的哪个节点、第几次尝试。 */
const AgentTaskFields = {
	task_id: z.string(),
	run_id: z.string(),
	orchestration_id: z.string(),
	/** 场景现在的名称（名称不跟版本走）。 */
	orchestration_name: z.string(),
	node_id: z.string(),
	/** 运行绑定的场景版本里这个节点的显示名称（子流程入口节点是子流程名称）；没有时不给。 */
	display_name: z.string().optional(),
	/** 节点类型，写作「包名/节点类型名」。 */
	node_type: z.string(),
	/** 任务所在的链实例（运行监控里的链）。 */
	chain_instance_id: z.string(),
	/**
	 * 子流程名称（与运行视图里链实例的 name 相同：没有名称字段的旧版本为子流程入口的节点 ID，名称为空时为空字符串），
	 * 取自运行绑定的场景版本；任务在主链上为 null。
	 */
	chain_name: z.string().nullable(),
	attempt: z.number().int(),
};

/** 派发给 Agent、还没结束的任务（占着槽位）。 */
export const RunningTaskView = z.object({
	...AgentTaskFields,
	/** dispatched：下载、安装、启动中；running：执行器已启动。 */
	status: z.enum(["dispatched", "running"]),
	/** 执行器启动的时间；准备中为 null。 */
	started_at: Timestamp.nullable(),
	/** 此刻在做的动作（见 CurrentAction）；没有时为 null，准备中也为 null。 */
	current_action: CurrentAction.nullable(),
	/** 最新进度（ctx.progress）；没上报过时为 null。说明里的 secret 值按写入时这次运行已知的 secret 打码；运行视图读取时还会按当时的 secret 再打一遍，所以写入之后才出现的 secret 值，运行视图会打码、这里不会。 */
	progress: TaskProgressView.nullable(),
});

/**
 * 在等这台 Agent 的任务：Agent 不在线、还在准备环境，或没有空闲槽位。
 * 超过 queue_expires_at 仍没有派发时任务以 env_error 失败（docs/SEMANTICS.md 的 queue_timeout）。
 */
export const QueuedTaskView = z.object({
	...AgentTaskFields,
	/** 进入排队的时间；重试的尝试从重新排队时算。 */
	queued_at: Timestamp,
	/** 排队超时的时间；没有设置排队超时的任务为 null。 */
	queue_expires_at: Timestamp.nullable(),
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
	/** 在等这台 Agent 的任务，按排队顺序（也是派发顺序）。 */
	queued_tasks: z.array(QueuedTaskView),
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
	/**
	 * 最近一次连接用的凭据（ADR 0029「迁移与过渡」，#492）：`agent` 是这台 Agent 自己的凭据，`shared` 是共享令牌
	 * （`SFLY_AGENT_TOKEN`，控制台提示换成 Agent 凭据），`none` 没带凭据（只在过渡版本里被接受）；还没有记过（升级之前连接的）为 null。
	 */
	auth_kind: z.enum(["agent", "shared", "none"]).nullable(),
	/** 停用这台 Agent 的时间；没有停用为 null。停用的 Agent 不能连接、不参与派发。 */
	disabled_at: Timestamp.nullable(),
});

/**
 * 一个 Agent 凭据（不含原值）：`prefix` 是展示用的前缀（`sfly_agt_` 加原值开头的几个字符），认得出是哪一个，不够用来连接；
 * `user` 是开发 Agent 的凭据所属的用户的显示名（按台签发的没有用户，为 null）。
 */
export const AgentCredentialView = z.object({
	id: z.uuid(),
	prefix: z.string(),
	created_at: Timestamp,
	last_used_at: Timestamp.nullable(),
	revoked_at: Timestamp.nullable(),
	user: z.string().nullable(),
});

/** 刚签发的 Agent 凭据：`token` 是原值，只在这一次响应里出现，之后任何接口都读不回。 */
export const IssuedAgentCredential = z.object({
	credential: AgentCredentialView,
	token: z.string(),
});

const AgentNameParams = z.object({
	/** Agent 名称。 */
	name: z.string().min(1),
});
const AgentCredentialParams = AgentNameParams.extend({ id: z.uuid() });
/**
 * 签发 Agent 凭据时的 Agent 名称：和 Agent 在 Hello 里报的名称同一个规则（#670）——不含 `text-safety.ts` 里那张明确的表里的字符，
 * 最多 {@link AGENT_NAME_MAX_LENGTH} 个字符（按字符数）。名称是身份，会显示在命令行、控制台和场景里，凭据签发之后 Agent
 * 才连得上来，所以在签发这一步就拦住；不合格的说明带第几个字符、哪个码位，不回显名称。名称在路径里：路径参数的长度上限
 * 是 128 个 UTF-16 码元（解码之后，控制面的路由设置），放得下 64 个 emoji 的名称。
 */
export const AgentNameText = z
	.string()
	.min(1)
	.refine((name) => nameProblem(name) === undefined, nameRefinement("Agent 的名称"))
	.refine(
		(name) => [...name].length <= AGENT_NAME_MAX_LENGTH,
		`Agent 的名称不能超过 ${AGENT_NAME_MAX_LENGTH} 个字符`,
	);
const NewAgentNameParams = z.object({
	/** Agent 名称。 */
	name: AgentNameText,
});

export const agentsApi = {
	/** 全部注册过的 Agent，按名称排序。 */
	list: endpoint({
		method: "GET",
		path: "/agents",
		summary: "列出全部 Agent：在线还是离线、槽位、正在执行和排队的任务、已装的节点包",
		effect: "read",
		resource: { kind: "agent", target: "collection" },
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
		summary: "让正在更新的 Agent 不再等手上的任务跑完，立即更新（终止这些任务）",
		effect: "write",
		resource: { kind: "agent", target: { params: "name" } },
		client: true,
		key: ["agents", "update-now"],
		params: z.object({
			/** Agent 名称。 */
			name: z.string().min(1),
		}),
		response: z.object({
			/** 被终止的任务：它们以 agent_lost 失败，按重试配置重新排队。 */
			terminated_tasks: z.array(RunningTaskView),
		}),
	}),
	/** 列出一台 Agent 的凭据（含已吊销的，带状态；不含原值）。 */
	listCredentials: endpoint({
		method: "GET",
		path: "/agents/:name/credentials",
		summary: "列出一台 Agent 的凭据（前缀、状态、最后使用时间，不含原值）",
		effect: "read",
		resource: { kind: "agent", target: { params: "name" } },
		client: false,
		key: ["agents", "credentials"],
		params: AgentNameParams,
		response: z.object({ credentials: z.array(AgentCredentialView) }),
	}),
	/**
	 * 为「项目 + Agent 名字」签发一个 Agent 凭据（`sfly_agt_` 前缀，库里只存哈希），响应里的 `token` 是原值，只此一次。
	 * 要「管理」范围（项目管理员）；同一台 Agent 可以同时有几个有效的凭据（轮换：先签发新的、换上之后吊销旧的）。
	 * 开发机上的开发 Agent 不走这里，走 devAgentsApi。
	 */
	issueCredential: endpoint({
		method: "POST",
		path: "/agents/:name/credentials",
		summary: "为一台 Agent 签发凭据（原值只在这次响应里出现一次）",
		effect: "write",
		resource: { kind: "agent", target: { params: "name" } },
		client: false,
		key: ["agents", "issue-credential"],
		params: NewAgentNameParams,
		response: IssuedAgentCredential,
	}),
	/** 吊销一台 Agent 的凭据，立即失效，用它连着的 Agent 连接被断开。要「管理」范围；已经吊销的再吊销是 204。 */
	revokeCredential: endpoint({
		method: "DELETE",
		path: "/agents/:name/credentials/:id",
		summary: "吊销一台 Agent 的凭据（连着的连接断开）",
		effect: "write",
		resource: { kind: "agent", target: { params: "name" } },
		removes: true,
		client: false,
		key: ["agents", "revoke-credential"],
		params: AgentCredentialParams,
		response: z.undefined(),
	}),
	/**
	 * 停用一台 Agent（ADR 0029「迁移与过渡」）：停用的 Agent 不能连接（不论带不带凭据）、不参与派发（预检阻断并写明原因）、
	 * 不计入「登记工作台之前都要换成 Agent 凭据」的检查。正连着的立即断开，它手上的任务按 Agent 失联处理（`agent_lost`，
	 * 租约到期后重试）。要「管理」范围；已经停用的再停用是 204。
	 */
	disable: endpoint({
		method: "POST",
		path: "/agents/:name/disable",
		summary: "停用一台 Agent（断开连接，不再派发）",
		effect: "write",
		resource: { kind: "agent", target: { params: "name" } },
		client: false,
		key: ["agents", "disable"],
		params: AgentNameParams,
		response: z.undefined(),
	}),
	/** 恢复一台停用的 Agent：之后同名的连接照常判断。要「管理」范围；没有停用的再恢复是 204。 */
	enable: endpoint({
		method: "POST",
		path: "/agents/:name/enable",
		summary: "恢复一台停用的 Agent",
		effect: "write",
		resource: { kind: "agent", target: { params: "name" } },
		client: false,
		key: ["agents", "enable"],
		params: AgentNameParams,
		response: z.undefined(),
	}),
};

/** 开发 Agent 名字里「主机」那一段：小写字母、数字、连字符，不以连字符开头或结尾；整个名字另有总长上限。 */
export const DEV_AGENT_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
export const DEV_AGENT_HOST_MAX = 32;
/** 开发 Agent 的名字（`dev-<登录名>-<主机>`）的总长上限。 */
export const DEV_AGENT_NAME_MAX = 64;

/**
 * 「我的开发 Agent」（ADR 0029「凭据」，资源类别 `dev_agent`）：在项目下新建和吊销。名字由控制面生成，请求里不能带
 * （`dev-<登录名>-<主机>`：登录名的字符集不含连字符，所以 `dev-` 之后到下一个连字符之前就是登录名，来自凭据，冒用不了别人的）；
 * 只认有用户的人的凭据（登录 Cookie、个人令牌），会话令牌和项目令牌都不行；要「编辑」范围；凭据记在这个用户名下。
 */
export const devAgentsApi = {
	/** 注册我的开发 Agent：返回控制面生成的名字和凭据（原值只此一次）；同一个人在同一个项目里重名是 409 `dev_agent_exists`。 */
	create: endpoint({
		method: "POST",
		path: "/projects/:project/dev-agents",
		summary: "在开发机上注册我的开发 Agent（名字由控制面生成）",
		effect: "write",
		resource: { kind: "dev_agent", target: "collection" },
		client: false,
		key: ["dev-agents", "create"],
		params: z.object({ project: z.string().min(1) }),
		body: z
			.object({
				/** 主机那一段：小写字母、数字、连字符。 */
				host: z.string().min(1).max(DEV_AGENT_HOST_MAX).regex(DEV_AGENT_HOST_PATTERN),
			})
			.strict(),
		response: z.object({ name: z.string(), credential: AgentCredentialView, token: z.string() }),
	}),
	/** 吊销一台开发 Agent 的凭据：要是自己的，或者有「管理」范围；已经吊销的再吊销是 204。 */
	revoke: endpoint({
		method: "DELETE",
		path: "/projects/:project/dev-agents/:name",
		summary: "吊销我的开发 Agent 的凭据",
		effect: "write",
		resource: { kind: "dev_agent", target: { params: "name" } },
		removes: true,
		client: false,
		key: ["dev-agents", "revoke"],
		params: z.object({ project: z.string().min(1), name: z.string().min(1) }),
		response: z.undefined(),
	}),
};

export type AgentView = z.infer<typeof AgentView>;
export type AgentCredentialView = z.infer<typeof AgentCredentialView>;
export type IssuedAgentCredential = z.infer<typeof IssuedAgentCredential>;
export type AgentUpdateState = z.infer<typeof AgentUpdateState>;
export type AgentUpdateView = z.infer<typeof AgentUpdateView>;
export type DevPackageView = z.infer<typeof DevPackageView>;
export type RunningTaskView = z.infer<typeof RunningTaskView>;
export type QueuedTaskView = z.infer<typeof QueuedTaskView>;
export type CapabilityView = z.infer<typeof CapabilityView>;
export type AgentEndpointView = z.infer<typeof AgentEndpointView>;
