import {
	REMOVED_NODE_KINDS,
	removedKindOutputs,
	removedNodesIn,
	type StoredOrchestrationDocument,
} from "@sfly/schema";
import { TriangleAlertIcon } from "lucide-react";
import { Banner } from "#/versions/DraftBanner";
import { Button } from "@/components/ui/button";

/** 「飞书通知节点」「定时节点」「Sleep 节点」：名称以字母结尾时和「节点」之间留一个空格（仓库别处都这样写）。 */
const kindName = (label: string) => (/[A-Za-z0-9]$/.test(label) ? `${label} 节点` : `${label}节点`);

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
	// 原来有输出的种类：别的节点引用过它们的输出的，删掉节点之后那些引用也要改。
	const referenced = kinds.some((kind) => removedKindOutputs(kind).length > 0)
		? "引用了它们输出的节点也要一起改。"
		: "";
	return (
		<Banner>
			<TriangleAlertIcon />
			<span>
				{`有 ${removed.length} 个节点的类型已不再支持（${removed.map((r) => r.id).join("、")}），不能运行，删掉之后才能保存。替换办法：${kinds
					.map(
						(kind) =>
							`${kindName(REMOVED_NODE_KINDS[kind].label)}改成${REMOVED_NODE_KINDS[kind].replacement}`,
					)
					.join("；")}。${referenced}`}
			</span>
			<Button size="sm" variant="ghost" onClick={() => onLocate(first.id)}>
				前往
			</Button>
		</Banner>
	);
}
