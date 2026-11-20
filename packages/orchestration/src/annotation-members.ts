import type { Annotation } from "@sfly/schema";
import { chainMembers, type StructureDocument, subflowTree } from "./structure.js";

/**
 * 注释框的成员：场景文档 `annotations` 一项里的 `nodes`（成员节点的节点 ID）和 `subflows`
 * （成员子流程，子流程入口的节点 ID）。字段只在 `Annotation` 里定义，用到这一组的地方都用这个类型。
 */
export type AnnotationMemberIds = Pick<Annotation, "nodes" | "subflows">;

/**
 * 从选中的一组节点新建注释框时，哪些记为子流程成员、哪些记为节点成员（#278）：
 * 子流程链上的节点（chainMembers，不含它下级的子流程）全被选中，就记这个子流程；子流程成员连同它下级的子流程
 * （docs/SEMANTICS.md §1.6），所以它和下级子流程链上的节点、下级子流程都不再单独记，以后加进这些子流程的节点也自动在框里。
 * 只选中一部分的子流程，那部分节点按节点成员记。其余选中的节点都记为节点成员。
 * 成员按节点在文档里的顺序排列；不在文档里的 ID 不记。
 */
export function annotationMembersOfSelection(
	doc: StructureDocument,
	selected: Iterable<string>,
): AnnotationMemberIds {
	const picked = new Set(selected);
	const chains = chainMembers(doc);
	const whole = doc.nodes.flatMap((n) => {
		const members = n.kind === "subflow_entry" ? (chains.get(n.id) ?? []) : [];
		return members.length > 0 && members.every((id) => picked.has(id)) ? [n.id] : [];
	});
	// 上级子流程也被记下时，下级子流程已经在框里。
	const below = new Set(whole.flatMap((entry) => subflowTree(doc, entry, chains).slice(1)));
	const subflows = whole.filter((entry) => !below.has(entry));
	const framed = new Set(
		subflows.flatMap((entry) =>
			subflowTree(doc, entry, chains).flatMap((sub) => chains.get(sub) ?? []),
		),
	);
	return {
		nodes: doc.nodes.flatMap((n) => (picked.has(n.id) && !framed.has(n.id) ? [n.id] : [])),
		subflows,
	};
}
