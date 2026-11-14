import { removeNode } from "./chain-edits.js";
import { type DocumentEdit, rejected } from "./edit-result.js";
import type { LayoutDocument } from "./layout.js";

/**
 * 删除一组节点（画布多选后删除）：按节点在文档里的顺序逐个 removeNode，每个都按单个删除的规则接上前后，
 * 结果与选中的先后无关。删不了的节点（入口节点）跳过，原因写在 `skipped`；一个都删不了时拒绝。
 */
export function removeNodes<D extends LayoutDocument>(
	doc: D,
	ids: readonly string[],
): DocumentEdit<D, { removed: string[]; skipped: { id: string; reason: string }[] }> {
	const wanted = new Set(ids);
	let next = doc;
	const removed: string[] = [];
	const skipped: { id: string; reason: string }[] = [];
	for (const { id } of doc.nodes.filter((n) => wanted.has(n.id))) {
		const edit = removeNode(next, id);
		if (edit.ok) {
			next = edit.doc;
			removed.push(id);
		} else {
			skipped.push({ id, reason: edit.reason });
		}
	}
	if (removed.length === 0) return rejected(skipped[0]?.reason ?? "没有要删除的节点");
	return { ok: true, doc: next, removed, skipped };
}
