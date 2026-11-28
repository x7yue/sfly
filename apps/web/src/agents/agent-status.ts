import type { AgentView } from "@sfly/schema";
import type { StatusKind, StatusView } from "#/components/status";
import { AGENT_AUTH, AGENT_STATUS_LABEL } from "#/lib/copy";

/** 这台 Agent 是不是被管理员停用了（停用的 Agent 不能连接、不参与派发，ADR 0029「迁移与过渡」）。 */
export const isDisabled = (agent: Pick<AgentView, "disabled_at">): boolean =>
	agent.disabled_at !== null;

/**
 * Agent 的状态（Agent 管理页机架的头部、控制台 Agent 列的名称行共用）：停用最优先（管理员的决定，不是掉线了；
 * 停用到连接真的关掉之间有一瞬还在线，也写已停用），其次更新中、更新失败、需要手动升级、版本不一致，
 * 再是安装节点包，最后是在线、离线。
 */
export function agentStatusView(agent: AgentView): StatusView {
	if (isDisabled(agent)) return { kind: "pending", label: AGENT_STATUS_LABEL.disabled };
	if (agent.status === "offline") return { kind: "pending", label: AGENT_STATUS_LABEL.offline };
	const update = updateStatus(agent);
	if (update) return update;
	if (agent.install?.state === "installing") return { kind: "warn", label: "安装中" };
	return { kind: "ok", label: AGENT_STATUS_LABEL.online };
}

/** 占用的槽位数：读者项目里的任务（`running_tasks`）加上别的项目的（只有个数，#500）。 */
export const usedSlots = (agent: Pick<AgentView, "running_tasks" | "other_project_running">) =>
	agent.running_tasks.length + agent.other_project_running;

/** 在等这台 Agent 的任务数：读者项目里的加上别的项目的。 */
export const queuedCount = (agent: Pick<AgentView, "queued_tasks" | "other_project_queued">) =>
	agent.queued_tasks.length + agent.other_project_queued;

/**
 * 这台 Agent 此刻能不能接新任务（与控制面派发的条件一致）：没有停用、在线、已准备好环境、版本与控制面一致
 * （更新中的 Agent 版本也不一致，ADR 0014）。不能接的 Agent 槽位不算空闲：不画空闲矮条、不写占用数，
 * 控制台也不把它合并进「N 台空闲」。
 */
export const acceptsTasks = (
	agent: Pick<AgentView, "status" | "preparing_since" | "version_mismatch" | "disabled_at">,
): boolean =>
	!isDisabled(agent) &&
	agent.status === "online" &&
	agent.preparing_since === null &&
	!agent.version_mismatch;

/**
 * 这台 Agent 最近一次连接用的凭据要不要提示（ADR 0029「迁移与过渡」，#492）：`shared`（共享令牌）提示换成 Agent 自己的凭据，
 * `none`（没有凭据）告警本版本内仍可连接、下一个版本起拒绝；`agent` 是该有的样子，不写；`null`（还没记过：
 * 升级之前连接的，或没连过）也不写，不替没有记录的事下结论。**停用的 Agent 不写**：它带什么凭据都连不上，
 * 「本版本内仍可连接」是假的，提示换凭据也没有意义（它不挡登记工作台，也不用换）；恢复之后再按最近一次连接写。
 */
export function authNotice(
	agent: Pick<AgentView, "auth_kind" | "disabled_at">,
): { kind: "shared" | "none"; label: string; hint: string; severity: "info" | "warn" } | null {
	if (isDisabled(agent)) return null;
	switch (agent.auth_kind) {
		case "shared":
			return { kind: "shared", ...AGENT_AUTH.shared, severity: "info" };
		case "none":
			return { kind: "none", ...AGENT_AUTH.none, severity: "warn" };
		case "agent":
		case null:
			return null;
	}
}

/**
 * 在线、停用的 Agent 各有几台（控制台 Agent 面板的标题计数、侧栏「Agent 管理」旁的数共用，口径一致）：
 * `enabled` 不含已停用的（管理员停用它是决定，不是掉线了）；`online` 也不含停用的（停用到连接真的关掉之间还在线的那一瞬不算）。
 */
export function agentCounts(agents: readonly Pick<AgentView, "status" | "disabled_at">[]) {
	const disabled = agents.filter(isDisabled).length;
	return {
		online: agents.filter((a) => !isDisabled(a) && a.status === "online").length,
		enabled: agents.length - disabled,
		disabled,
	};
}

/**
 * 在线 Agent 的更新状态（ADR 0014）：版本与控制面不一致时不接新任务，状态后面说明它在做什么；
 * 不需要更新时为 undefined。
 */
const UPDATING = "更新中";

export function updateStatus(
	agent: AgentView,
): { kind: StatusKind; label: string; detail?: string } | undefined {
	const { update } = agent;
	switch (update.state) {
		case "downloading":
			return { kind: "running", label: UPDATING, detail: "下载新版本" };
		case "waiting_for_tasks":
			return {
				kind: "running",
				label: UPDATING,
				detail: `等待 ${update.remaining_tasks} 个任务结束`,
			};
		case "replacing":
			return { kind: "running", label: UPDATING, detail: "替换并重新启动" };
		case "failed":
			return { kind: "failed", label: "更新失败", detail: update.reason };
		case "manual_upgrade_required":
			return { kind: "warn", label: "需要手动升级", detail: update.reason };
		case "none":
			return agent.version_mismatch ? { kind: "warn", label: "版本不一致" } : undefined;
	}
}
