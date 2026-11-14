import { type DocumentDiff, subflowLabels } from "@sfly/orchestration";
import type { OrchestrationDocument } from "@sfly/schema";
import { ReactFlowProvider } from "@xyflow/react";
import { useCallback, useMemo, useState } from "react";
import type { CanvasInfo, NodeDecoration } from "#/components/canvas/context";
import { FlowCanvas } from "#/components/canvas/FlowCanvas";
import { toFlow } from "#/components/canvas/flow";
import { usePackageTitles } from "#/components/canvas/package-titles";
import { LOD_HIDDEN, ZOOM_TEXT_12 } from "#/components/canvas/zoom-text";
import { type StatusKind, StatusPill } from "#/components/status";

export type NodeMark = NonNullable<NodeDecoration["mark"]>;

/** 一侧画布上的差异标记：A（旧）侧标出删除和修改的节点，B（新）侧标出新增和修改的节点。 */
export function marksOf(diff: DocumentDiff, side: "a" | "b"): Map<string, NodeMark> {
	const marks = new Map<string, NodeMark>();
	for (const n of diff.nodes.changed) marks.set(n.id, "changed");
	for (const n of side === "a" ? diff.nodes.removed : diff.nodes.added) {
		marks.set(n.id, side === "a" ? "removed" : "added");
	}
	return marks;
}

const MARK_STATUS: Record<NodeMark, { kind: StatusKind; label: string }> = {
	added: { kind: "ok", label: "新增" },
	removed: { kind: "failed", label: "删除" },
	changed: { kind: "warn", label: "修改" },
};

/**
 * 只读画布：查看某个场景版本（复用编排画布 FlowCanvas，`editable={false}`），显示子流程区域；
 * marks 给节点加差异标记（卡片描边 + 右上角状态文字）。可以平移、缩放、选中节点，不能修改。
 */
export function VersionCanvas({
	label,
	document,
	marks,
}: {
	label: string;
	document: OrchestrationDocument;
	marks?: ReadonlyMap<string, NodeMark>;
}) {
	const titleOf = usePackageTitles();
	const flow = useMemo(() => toFlow(document), [document]);
	const [selectedId, setSelectedId] = useState<string | null>(null);

	const info: CanvasInfo = useMemo(
		() => ({
			defaultAgent: document.default_agent,
			titleOf,
			packages: document.packages,
			subflowLabelOf: subflowLabels(document),
			warnings: new Map(),
		}),
		[document, titleOf],
	);

	const decorateNode = useCallback(
		(id: string): NodeDecoration | undefined => {
			const mark = marks?.get(id);
			if (!mark) return undefined;
			const { kind, label } = MARK_STATUS[mark];
			return {
				mark,
				status: (
					<StatusPill kind={kind} className={ZOOM_TEXT_12}>
						{/* 缩小视图时只留色点：差异已由描边颜色与上方的差异列表说明，把宽度让给节点 ID。 */}
						<span className={LOD_HIDDEN}>{label}</span>
					</StatusPill>
				),
			};
		},
		[marks],
	);

	return (
		<ReactFlowProvider>
			<FlowCanvas
				label={label}
				nodes={flow.nodes}
				edges={flow.edges}
				info={info}
				selectedId={selectedId}
				onSelect={setSelectedId}
				insets={{ top: 0, right: 0, bottom: 0, left: 0 }}
				decorateNode={decorateNode}
				initialMinimap={false}
				refitOnResize
			/>
		</ReactFlowProvider>
	);
}
