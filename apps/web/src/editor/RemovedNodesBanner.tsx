import { REMOVED_NODE_KINDS, removedNodesIn, type StoredOrchestrationDocument } from "@sfly/schema";
import { TriangleAlertIcon } from "lucide-react";
import { Banner } from "#/versions/DraftBanner";
import { Button } from "@/components/ui/button";

/**
 * 画布顶部的提示：场景里还有已移除种类的节点（ADR 0028，历史版本里留着它们）。写明是哪些节点、怎么替换；
 * 它们不能运行，也不能保存，在画布上删掉之后才能保存。没有这样的节点时什么也不显示。
 */
export function RemovedNodesBanner({
	doc,
	onLocate,
}: {
	doc: StoredOrchestrationDocument;
	onLocate: (id: string) => void;
}) {
	const removed = removedNodesIn(doc);
	const [first] = removed;
	if (!first) return null;
	const kinds = [...new Set(removed.map((r) => r.kind))];
	return (
		<Banner>
			<TriangleAlertIcon />
			<span>
				有 {removed.length} 个节点的类型已不再支持（{removed.map((r) => r.id).join("、")}
				），不能运行，也不能保存，删掉之后才能保存。替换办法：
				{kinds
					.map(
						(kind) =>
							`${REMOVED_NODE_KINDS[kind].label}节点：${REMOVED_NODE_KINDS[kind].replacement}`,
					)
					.join("；")}
				。
			</span>
			<Button size="sm" variant="ghost" onClick={() => onLocate(first.id)}>
				前往
			</Button>
		</Banner>
	);
}
