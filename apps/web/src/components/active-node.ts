import { isOnAgentStatus, type RunListActiveNode } from "@sfly/schema";
import { nodeStatusView } from "#/components/status";
import { attemptLabel } from "#/lib/copy";
import { formatElapsed } from "#/lib/format";

/**
 * 进行中的节点（排队中、准备中、执行中、等待中）那一行的一项：控制台运行块和运行监控概览的链路共用，
 * 两处写法一致（规格 #346 故事 8）。
 */
export type ActiveNode = Pick<RunListActiveNode, "status" | "agent" | "attempt" | "started_at">;

/** 先执行中（含准备中），再排队、等待；同一类按链与链上的顺序（`Array.sort` 是稳定的）。 */
export const activeOrder = (node: Pick<ActiveNode, "status">) =>
	isOnAgentStatus(node.status) ? 0 : node.status === "queued" ? 1 : 2;

/**
 * 「agent-a · 第 2 次尝试 · 1m 05s」；还没开始执行（排队中、准备中）的时长处写状态，不从排队算起；
 * 不在 Agent 上的节点（停止子流程节点）只写状态。时长每秒刷新，用 `formatElapsed`。
 */
export function activeDetail(node: ActiveNode, now: number): string {
	const status = nodeStatusView(node.status);
	if (node.agent === null) return status.label;
	const time =
		node.started_at === null ? status.label : formatElapsed(now - Date.parse(node.started_at));
	return `${node.agent} · ${attemptLabel(node.attempt)} · ${time}`;
}
