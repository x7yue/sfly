import { chainMembers } from "@sfly/orchestration";
import { ViewportPortal } from "@xyflow/react";
import { cn } from "cn";
import { useMemo } from "react";
import { useFlowCanvas } from "./context";
import type { SfEdge, SfNode } from "./flow";
import { NODE_HEIGHT, NODE_WIDTH, REGION_PADDING } from "./geometry";
import { subflowLabel } from "./node-display";
import { ZOOM_TEXT_12 } from "./zoom-text";

interface Region {
	id: string;
	/** 子流程名称（subflowLabel）。 */
	name: string;
	trigger: string | undefined;
	count: number;
	box: { x: number; y: number; w: number; h: number };
}

/** 每个子流程（子流程入口节点及它链上的节点）的外接框，四周按 REGION_PADDING 留白。 */
export function subflowRegions(nodes: SfNode[], edges: SfEdge[]): Region[] {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const members = chainMembers({
		nodes: nodes.map((n) => ({ id: n.id, kind: n.data.node.kind })),
		edges: edges.map((e) => ({ from: e.source, to: e.target, kind: e.data?.kind ?? "chain" })),
	});
	const out: Region[] = [];
	for (const [start, ids] of members) {
		const entry = byId.get(start)?.data.node;
		if (entry?.kind !== "subflow_entry") continue;
		const at = ids.flatMap((id) => {
			const n = byId.get(id);
			return n ? [n.position] : [];
		});
		const x = Math.min(...at.map((p) => p.x)) - REGION_PADDING.left;
		const y = Math.min(...at.map((p) => p.y)) - REGION_PADDING.top;
		const x1 = Math.max(...at.map((p) => p.x)) + NODE_WIDTH + REGION_PADDING.right;
		const y1 = Math.max(...at.map((p) => p.y)) + NODE_HEIGHT + REGION_PADDING.bottom;
		out.push({
			id: start,
			name: subflowLabel(entry),
			trigger: edges.find((e) => e.target === start && e.data?.kind === "dispatch")?.source,
			count: ids.length,
			box: { x, y, w: x1 - x, h: y1 - y },
		});
	}
	return out;
}

/**
 * 子流程区域（原型 `.region`）：紫色虚线框，标题行写子流程名称和触发它的异步任务节点。
 * 标题行右侧可以由 FlowCanvas 的 regionMeta 替换（运行状态，#41）。画在节点和连线下面。
 */
export function SubflowRegions({ nodes, edges }: { nodes: SfNode[]; edges: SfEdge[] }) {
	const { regionMeta } = useFlowCanvas();
	const regions = useMemo(() => subflowRegions(nodes, edges), [nodes, edges]);
	return (
		<ViewportPortal>
			{regions.map((r) => (
				<section
					key={r.id}
					aria-label={`子流程 ${r.name}`}
					className="pointer-events-none absolute -z-10 rounded-xl border border-dashed border-canvas-subflow-line bg-canvas-subflow-soft"
					style={{ left: r.box.x, top: r.box.y, width: r.box.w, height: r.box.h }}
				>
					<div
						className={cn(
							"absolute top-2.25 right-3.5 left-3.5 flex items-center gap-2 whitespace-nowrap text-canvas-subflow-fg",
							ZOOM_TEXT_12,
						)}
					>
						<span>子流程</span>
						<span className="truncate font-medium text-canvas-subflow">{r.name}</span>
						<span className="pointer-events-auto ml-auto truncate text-fg-3">
							{regionMeta?.(r.id) ??
								`${r.trigger ? `由 ${r.trigger} 触发` : "没有异步任务节点触发"} · ${r.count} 个节点`}
						</span>
					</div>
				</section>
			))}
		</ViewportPortal>
	);
}
