import type { AgentView } from "@sfly/schema";
import type { StatusKind, StatusView } from "#/components/status";

/**
 * Agent 的状态（Agent 管理页机架的头部、控制台 Agent 列的名称行共用）：更新中、更新失败、需要手动升级、版本不一致这些优先，
 * 其次是安装节点包，再是在线、离线。
 */
export function agentStatusView(agent: AgentView): StatusView {
	if (agent.status === "offline") return { kind: "pending", label: "离线" };
	const update = updateStatus(agent);
	if (update) return update;
	if (agent.install?.state === "installing") return { kind: "warn", label: "安装中" };
	return { kind: "ok", label: "在线" };
}

/**
 * 在线 Agent 的更新状态（ADR 0014）：版本与控制面不一致时不接新任务，状态后面说明它在做什么；
 * 不需要更新时为 undefined。
 */
export function updateStatus(
	agent: AgentView,
): { kind: StatusKind; label: string; detail?: string } | undefined {
	const { update } = agent;
	switch (update.state) {
		case "downloading":
			return { kind: "running", label: "更新中", detail: "下载新版本" };
		case "waiting_for_tasks":
			return {
				kind: "running",
				label: "更新中",
				detail: `等待 ${update.remaining_tasks} 个任务结束`,
			};
		case "replacing":
			return { kind: "running", label: "更新中", detail: "替换并重新启动" };
		case "failed":
			return { kind: "failed", label: "更新失败", detail: update.reason };
		case "manual_upgrade_required":
			return { kind: "warn", label: "需要手动升级", detail: update.reason };
		case "none":
			return agent.version_mismatch ? { kind: "warn", label: "版本不一致" } : undefined;
	}
}
