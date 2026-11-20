import { REMOVED_NODE_KINDS, removedKindLabel, removedNodesIn } from "@sfly/schema";
import { nodeNameWithId } from "./node-display.js";

/** 文档里有已移除种类的节点（ADR 0028）：保存时警告，触发时阻断；从画布上删掉就没有了。 */
export interface RemovedNodeWarning {
	code: "node_kind_removed";
	message: string;
	node_id: string;
}

/**
 * 已移除节点的检查：每个这样的节点一条警告，写明它的种类和替换办法。保存时只警告：已保存的版本不改，
 * 带着它的文档在画布上能打开；触发被预检阻断，保存新版本要先把它们删掉（控制面拒绝保存，错误信息同样写明）。
 */
export function removedNodeWarnings(doc: {
	nodes: readonly {
		id: string;
		kind: string;
		display_name?: string | undefined;
	}[];
}): RemovedNodeWarning[] {
	const byId = new Map(doc.nodes.map((n) => [n.id, n]));
	return removedNodesIn(doc).map(({ id, kind, replacement }) => ({
		code: "node_kind_removed",
		message: `节点 ${nodeNameWithId(byId.get(id) ?? { id, kind })} 的类型（${removedKindLabel(kind)}，原来的「${REMOVED_NODE_KINDS[kind].label}」）已不再支持，不能运行。替换办法：${replacement}`,
		node_id: id,
	}));
}
