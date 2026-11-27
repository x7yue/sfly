import type { AgentView, RunFocusItem } from "@sfly/schema";
import { acceptsTasks, agentStatusView, isDisabled } from "#/agents/agent-status";
import { countAttention, type FocusPreview, focusPreview } from "#/focus/focus-preview";
import { AGENT_STATUS_LABEL } from "#/lib/copy";

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
	const preview = focusPreview(
		items,
		Math.max(readoutCells(width, activeLimit), countAttention(items)),
	);
	const cells = preview.shown.length + (preview.more > 0 ? 1 : 0);
	return { ...preview, columns: Math.min(cells, readoutCells(width, null) + 1) };
}

/** Agent 超过这么多台时，控制台右栏只列需要看的 Agent，其余合并成「N 台空闲」。 */
const AGENT_LIST_MAX = 5;

/**
 * 控制台右栏的 Agent：不超过 5 台时全列；更多时只列忙碌（有执行中或排队的任务）、接不了新任务（离线、准备环境中、版本不一致、
 * 更新中，`acceptsTasks`）和其余不是「在线」状态（安装节点包中）的 Agent，其余在线、空闲、能接任务的合并成一个数。
 * 完整的列表在 Agent 管理页。
 */
export function agentColumn(agents: readonly AgentView[]): { listed: AgentView[]; idle: number } {
	if (agents.length <= AGENT_LIST_MAX) return { listed: [...agents], idle: 0 };
	const listed = agents.filter(
		(agent) =>
			!acceptsTasks(agent) ||
			agentStatusView(agent).kind !== "ok" ||
			agent.running_tasks.length > 0 ||
			agent.queued_tasks.length > 0,
	);
	return { listed, idle: agents.length - listed.length };
}

/**
 * 控制台右栏 Agent 面板标题旁的计数：「2 / 3 在线」。分母不含已停用的 Agent（管理员停用它是决定，不是掉线了，
 * 不该让「在线」的比例看起来像出了问题）；有停用的再接「· 1 台已停用」。
 */
export function agentCountLabel(agents: readonly AgentView[]): string {
	const disabled = agents.filter(isDisabled).length;
	const enabled = agents.length - disabled;
	const online = agents.filter((a) => !isDisabled(a) && a.status === "online").length;
	const base = `${online} / ${enabled} ${AGENT_STATUS_LABEL.online}`;
	return disabled === 0 ? base : `${base} · ${disabled} 台${AGENT_STATUS_LABEL.disabled}`;
}
