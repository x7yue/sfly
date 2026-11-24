import { type LayoutDocument, type SubflowRegion, subflowRegions } from "@sfly/orchestration";
import { useStore, ViewportPortal } from "@xyflow/react";
import { cn } from "cn";
import { useMemo } from "react";
import { subflowLabel } from "#/lib/copy";
import { useFlowCanvas } from "./context";
import type { SfEdge, SfNode } from "./flow";
import { ZOOM_TEXT_12 } from "./zoom-text";

interface Region extends SubflowRegion {
	/** 子流程名称（subflowLabel）。 */
	name: string;
	trigger: string | undefined;
}

/** 每个子流程的区域（@sfly/orchestration 的 subflowRegions），带上名称和触发它的异步任务节点。 */
function namedRegions(layout: LayoutDocument, nodes: SfNode[], edges: SfEdge[]): Region[] {
	const byId = new Map(nodes.map((n) => [n.id, n.data.node]));
	return subflowRegions(layout).flatMap((r) => {
		const entry = byId.get(r.entry);
		if (entry?.kind !== "subflow_entry") return [];
		const trigger = edges.find((e) => e.target === r.entry && e.data?.kind === "dispatch")?.source;
		return [{ ...r, name: subflowLabel(entry), trigger }];
	});
}

/** 标题栏左右各留 14px（`left-3.5`）。 */
const HEADER_INSET = 14;
/**
 * 标题行底边离区域顶边的距离：标题行按底边放在区域上方的留白里，缩小视图时文字变大往上长，
 * 不被下面的卡片挡住（和注释框的标题带一样）。标题行和卡片（REGION_PADDING.top 处）之间的空隙留给卡片上的标签。
 */
const HEADER_BOTTOM = 30;

/** 默认的元信息（谁触发、几个节点）放得下需要多宽，单位是标题栏的字号：窄于它就整段去掉，把空间留给名字。 */
const META_FITS_EM = 24;

/**
 * 子流程区域（原型 `.region`）：紫色虚线框，标题行写子流程名称和触发它的异步任务节点。
 * 标题行右侧可以由 FlowCanvas 的 regionMeta 替换（运行状态，#41）；区域窄到放不下默认的元信息时，
 * 先整段去掉它，名字最后才截断（运行状态的内容不去掉，它收缩到截断）。画在节点和连线下面。
 * 给了 `onSelect` 时（可编辑的画布）标题可以点，点了选中子流程链上的全部节点。
 */
export function SubflowRegions({
	layout,
	nodes,
	edges,
	onSelect,
}: {
	/** 画布上的节点和连线（flow.ts 的 layoutOf）。 */
	layout: LayoutDocument;
	nodes: SfNode[];
	edges: SfEdge[];
	onSelect?: (ids: readonly string[]) => void;
}) {
	const { regionMeta, decorateNode, grounds } = useFlowCanvas();
	const regions = useMemo(() => namedRegions(layout, nodes, edges), [layout, nodes, edges]);
	const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n.data.node])), [nodes]);
	/** 区域里有挂着站外一行（NodeCard）的站：执行中、失败或等待中。 */
	const watched = (r: Region) =>
		r.members.some((id) => {
			const node = byId.get(id);
			return node !== undefined && decorateNode?.(id, node)?.overview !== undefined;
		});
	// 用 JS 算而不是容器查询：标题栏的字号随缩放变，Chromium 不会因为容器的字号变了重新计算依赖 em 的容器查询。
	const zoom = useStore((s) => s.transform[2]);
	const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
	const fontPx = Math.max(0.75 * rem, (0.75 * rem) / zoom);
	return (
		<ViewportPortal>
			{regions.map((r) => {
				const custom = regionMeta?.(r.entry);
				// 区域画在注释框的底板上时（框住了这个子流程），标题行的说明换成底板上的次要文字色：fg-3 在
				// 「底板加区域的淡紫」上只有约 3.6:1。
				const box = grounds.get(r.entry)?.color;
				const framed = box !== undefined && box !== "canvas" ? box : undefined;
				const fits = r.box.w - 2 * HEADER_INSET >= META_FITS_EM * fontPx;
				const meta =
					custom ??
					(fits
						? `${r.trigger ? `由 ${r.trigger} 触发` : "没有异步任务节点触发"} · ${r.members.length} 个节点`
						: null);
				return (
					<section
						key={r.entry}
						aria-label={`子流程 ${r.name}`}
						data-annotation-color={framed}
						className="pointer-events-none absolute -z-10 rounded-xl border border-dashed border-canvas-subflow-line bg-canvas-subflow-soft"
						style={{ left: r.box.x, top: r.box.y, width: r.box.w, height: r.box.h }}
					>
						<div
							className={cn(
								"absolute right-3.5 left-3.5 flex items-center gap-2 whitespace-nowrap text-canvas-subflow-fg",
								ZOOM_TEXT_12,
							)}
							style={{ bottom: r.box.h - HEADER_BOTTOM }}
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
								<span
									className={cn(
										"pointer-events-auto ml-auto min-w-0 shrink-100 truncate",
										framed ? "text-canvas-annotation-fg-2" : "text-fg-3",
										// 看全图时，区域里要盯的站自己挂着站外一行（标题加数字或原因），标题行右侧的运行状态和它重复：
										// 藏起来，给上面一个区域伸下来的站外一行让出位置（invisible 保留位置，名字不重新排）。
										custom !== undefined && watched(r) && "in-data-[lod-far=true]:invisible",
									)}
								>
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
