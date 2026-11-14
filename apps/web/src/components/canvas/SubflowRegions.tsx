import { chainMembers } from "@sfly/orchestration";
import { useStore, ViewportPortal } from "@xyflow/react";
import { cn } from "cn";
import { useMemo } from "react";
import { subflowLabel } from "#/lib/copy";
import { useFlowCanvas } from "./context";
import type { SfEdge, SfNode } from "./flow";
import { NODE_HEIGHT, NODE_WIDTH, REGION_PADDING } from "./geometry";
import { ZOOM_TEXT_12 } from "./zoom-text";

interface Region {
	id: string;
	/** 子流程名称（subflowLabel）。 */
	name: string;
	trigger: string | undefined;
	/** 子流程链上的节点（子流程入口在最前，按链上顺序；不含它下级的子流程）。 */
	members: string[];
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
			members: ids,
			box: { x, y, w: x1 - x, h: y1 - y },
		});
	}
	return out;
}

/** 标题栏左右各留 14px（`left-3.5`）。 */
const HEADER_INSET = 14;

/** 默认的元信息（谁触发、几个节点）放得下需要多宽，单位是标题栏的字号：窄于它就整段去掉，把空间留给名字。 */
const META_FITS_EM = 24;

/**
 * 子流程区域（原型 `.region`）：紫色虚线框，标题行写子流程名称和触发它的异步任务节点。
 * 标题行右侧可以由 FlowCanvas 的 regionMeta 替换（运行状态，#41）；区域窄到放不下默认的元信息时，
 * 先整段去掉它，名字最后才截断（运行状态的内容不去掉，它收缩到截断）。画在节点和连线下面。
 * 给了 `onSelect` 时（可编辑的画布）标题可以点，点了选中子流程链上的全部节点。
 */
export function SubflowRegions({
	nodes,
	edges,
	onSelect,
}: {
	nodes: SfNode[];
	edges: SfEdge[];
	onSelect?: (ids: readonly string[]) => void;
}) {
	const { regionMeta } = useFlowCanvas();
	const regions = useMemo(() => subflowRegions(nodes, edges), [nodes, edges]);
	// 用 JS 算而不是容器查询：标题栏的字号随缩放变，Chromium 不会因为容器的字号变了重新计算依赖 em 的容器查询。
	const zoom = useStore((s) => s.transform[2]);
	const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
	const fontPx = Math.max(0.75 * rem, (0.75 * rem) / zoom);
	return (
		<ViewportPortal>
			{regions.map((r) => {
				const custom = regionMeta?.(r.id);
				const fits = r.box.w - 2 * HEADER_INSET >= META_FITS_EM * fontPx;
				const meta =
					custom ??
					(fits
						? `${r.trigger ? `由 ${r.trigger} 触发` : "没有异步任务节点触发"} · ${r.members.length} 个节点`
						: null);
				return (
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
							{onSelect ? (
								// 不进 Tab 顺序：画布只有画布区域一个停靠点（键盘用方向键浏览节点）。
								<button
									type="button"
									tabIndex={-1}
									aria-label={`选中子流程 ${r.name} 的全部节点`}
									className="pointer-events-auto flex min-w-0 cursor-pointer items-center gap-2"
									onClick={() => onSelect(r.members)}
								>
									<RegionTitle name={r.name} />
								</button>
							) : (
								<RegionTitle name={r.name} />
							)}
							{meta && (
								<span className="pointer-events-auto ml-auto min-w-0 shrink-100 truncate text-fg-3">
									{meta}
								</span>
							)}
						</div>
					</section>
				);
			})}
		</ViewportPortal>
	);
}

function RegionTitle({ name }: { name: string }) {
	return (
		<>
			<span className="flex-none">子流程</span>
			<span className="min-w-0 truncate font-semibold text-canvas-subflow">{name}</span>
		</>
	);
}
