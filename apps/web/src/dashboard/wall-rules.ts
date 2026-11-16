import type { AgentView, RunFocusItem } from "@sfly/schema";
import { agentStatusView } from "#/agents/agent-status";
import { type FocusPreview, focusPreview } from "#/focus/focus-preview";

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
	/** 运行块里进行中的节点和读数最多列几个；null 是全列（读数按运行块的宽度，见 {@link readoutCells}）。 */
	activeLimit: number | null;
}

export function wallLayout(runs: number): WallLayout {
	return {
		compact: runs >= COMPACT_FROM,
		activeLimit: runs >= LIMIT_FROM ? ACTIVE_LIMIT : null,
	};
}

/** 读数区的一格（含「还有 N 个关注项」那一格）至少这么宽（px）。 */
const READOUT_CELL_MIN_WIDTH = 140;
const READOUT_CELLS_MIN = 3;
const READOUT_CELLS_MAX = 4;

/**
 * 运行块里的读数区放几格关注项。`width` 是读数区的实际宽度（px，运行块的内容宽度，不是窗口宽度）：「还有 N 个关注项」也占
 * 一格，每格至少 {@link READOUT_CELL_MIN_WIDTH}，放 3 或 4 格（1440 的窗口里 4 格，1280 的窗口里 3 格）。
 * 3 个以上运行时（`activeLimit` 不是 null）每块只放前 `activeLimit` 项，不看宽度。
 */
export function readoutCells(width: number, activeLimit: number | null): number {
	if (activeLimit !== null) return activeLimit;
	const fit = Math.floor(width / READOUT_CELL_MIN_WIDTH) - 1;
	return Math.min(READOUT_CELLS_MAX, Math.max(READOUT_CELLS_MIN, fit));
}

/** 运行块读数区怎么排：显示哪几项（{@link focusPreview} 的结果）和排几列。 */
export interface ReadoutPlan<T> extends FocusPreview<T> {
	/** 等宽的列数：显示的项数加上「还有 N 个关注项」那一格，最多是按宽度能放的格数加这一格；异常比格数多时换行。 */
	columns: number;
}

/**
 * 运行块的读数区显示哪几项、排几列：`items` 是控制面排好的读数（有异常的在最前），取前 {@link readoutCells} 项，
 * 其余计数（`more`）。有异常的总在里面：异常比格数多时全部显示。
 */
export function readoutPlan<T extends Pick<RunFocusItem, "anomaly">>(
	items: readonly T[],
	width: number,
	activeLimit: number | null,
): ReadoutPlan<T> {
	const attention = items.filter((item) => item.anomaly !== null).length;
	const preview = focusPreview(items, Math.max(readoutCells(width, activeLimit), attention));
	const cells = preview.shown.length + (preview.more > 0 ? 1 : 0);
	return { ...preview, columns: Math.min(cells, readoutCells(width, null) + 1) };
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
