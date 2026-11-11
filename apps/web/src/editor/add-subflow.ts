import {
	NODE_SIZE,
	type Position,
	type StructureDocument,
	SUBFLOW_INDENT,
	SUBFLOW_TOP_GAP,
} from "@sfly/orchestration";
import { type DocEdge, type SfNode, toFlowNode, uniqueNodeId } from "#/components/canvas/flow";
import { freePosition, idStem, newDocNode } from "./add-node";

/**
 * 新建子流程一步完成（#187）：添加异步任务节点时顺手建好子流程，或从异步任务节点的调度端口拖线到空白处新建子流程入口。
 * 两种都得到子流程入口节点和一条调度连线；名称的检查与新建子流程入口相同（add-node.ts 的 newSubflowNameProblem）。
 */

/** 随异步任务节点一起新建的子流程入口节点（画布节点），以及从异步任务节点连过去的调度连线。 */
export interface CompanionSubflow {
	node: SfNode;
	edge: DocEdge;
}

/**
 * 子流程入口放在异步任务节点右下方，与整理布局里子流程相对触发它的异步任务节点的位置相同；
 * 压住已有节点时按固定步长错开（freePosition）。`existing` 不含这个异步任务节点时也不会压住它。
 */
export function companionSubflow(
	trigger: { id: string; position: Position },
	name: string,
	existing: readonly { id: string; position: Position }[],
): CompanionSubflow {
	const item = { kind: "subflow_entry", name } as const;
	const others = [...existing, trigger];
	const id = uniqueNodeId(
		idStem(item),
		others.map((n) => n.id),
	);
	const position = freePosition(
		{
			x: trigger.position.x + SUBFLOW_INDENT,
			y: trigger.position.y + NODE_SIZE.height + SUBFLOW_TOP_GAP,
		},
		others.map((n) => n.position),
	);
	return {
		node: toFlowNode(newDocNode(item, id), position),
		edge: { from: trigger.id, to: id, kind: "dispatch" },
	};
}

/**
 * 能不能从这个异步任务节点的调度端口新建子流程：已有调度连线时不行（一个异步任务节点只调度一个子流程），
 * 返回原因；可以时返回 null。
 */
export function dispatchProblem(doc: Pick<StructureDocument, "edges">, id: string): string | null {
	const taken = doc.edges.some((e) => e.kind === "dispatch" && e.from === id);
	return taken ? `异步任务节点 ${id} 已有调度连线` : null;
}
