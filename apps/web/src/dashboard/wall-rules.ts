import type { AgentView } from "@sfly/schema";
import { agentStatusView } from "#/agents/agent-status";

/**
 * 实况墙在数量变多时的退化规则（外壳页方案 4.2）。长链折叠在线路组件里（`components/run-lines` 的 `foldStations`）。
 */

/** 同时有这么多个运行时，每个运行块里进行中的节点只列前 {@link ACTIVE_LIMIT} 个。 */
const LIMIT_FROM = 3;
export const ACTIVE_LIMIT = 2;
/** 同时有这么多个运行时，运行块换成一行一个的紧凑行。 */
const COMPACT_FROM = 6;

export interface WallLayout {
	/** 运行块换成一行一个的紧凑行（场景、线路缩略、当前节点、已运行），点开再展开成运行块。紧凑行不取读数。 */
	compact: boolean;
	/** 运行块里进行中的节点和读数最多列几个；null 是全列。 */
	activeLimit: number | null;
}

export function wallLayout(runs: number): WallLayout {
	return {
		compact: runs >= COMPACT_FROM,
		activeLimit: runs >= LIMIT_FROM ? ACTIVE_LIMIT : null,
	};
}

/** Agent 超过这么多台时，控制台右栏只列需要看的 Agent，其余合并成「N 台空闲」。 */
const AGENT_LIST_MAX = 5;

/**
 * 控制台右栏的 Agent：不超过 5 台时全列；更多时只列忙碌（有执行中或排队的任务）、离线、更新中（以及安装中、版本不一致这些
 * 不是「在线」的状态）的 Agent，其余在线、空闲的合并成一个数。完整的列表在 Agent 管理页。
 */
export function agentColumn(agents: readonly AgentView[]): { listed: AgentView[]; idle: number } {
	if (agents.length <= AGENT_LIST_MAX) return { listed: [...agents], idle: 0 };
	const listed = agents.filter(
		(agent) =>
			agentStatusView(agent).kind !== "ok" ||
			agent.running_tasks.length > 0 ||
			agent.queued_tasks.length > 0,
	);
	return { listed, idle: agents.length - listed.length };
}
