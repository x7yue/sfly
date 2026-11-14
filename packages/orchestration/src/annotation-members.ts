import { chainMembers, type StructureDocument } from "./structure.js";

/** 新建注释框时记下的成员（场景文档 `annotations` 一项里的 `nodes` 和 `subflows`）。 */
export interface AnnotationMemberIds {
	/** 成员节点的节点 ID。 */
	nodes: string[];
	/** 成员子流程：子流程入口的节点 ID。 */
	subflows: string[];
}

/**
 * 从选中的一组节点新建注释框时，哪些记为子流程成员、哪些记为节点成员（#278）：
 * 子流程链上的节点（chainMembers，不含它下级的子流程）全被选中，就记这个子流程，链上的节点不再单独记，
 * 以后加进这个子流程的节点也自动在框里；只选中一部分的子流程，那部分节点按节点成员记。
 * 其余选中的节点都记为节点成员。成员按节点在文档里的顺序排列；不在文档里的 ID 不记。
 */
export function annotationMembersOfSelection(
	doc: StructureDocument,
	selected: Iterable<string>,
): AnnotationMemberIds {
	const picked = new Set(selected);
	const chains = chainMembers(doc);
	const whole = doc.nodes.flatMap((n) => {
		const members = n.kind === "subflow_entry" ? (chains.get(n.id) ?? []) : [];
		return members.length > 0 && members.every((id) => picked.has(id))
			? [{ entry: n.id, members }]
			: [];
	});
	const inSubflow = new Set(whole.flatMap((s) => s.members));
	return {
		nodes: doc.nodes.flatMap((n) => (picked.has(n.id) && !inSubflow.has(n.id) ? [n.id] : [])),
		subflows: whole.map((s) => s.entry),
	};
}
