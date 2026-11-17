import { EdgeLabelRenderer, type EdgeProps, useInternalNode, useStore } from "@xyflow/react";
import { cn } from "cn";
import { useFlowCanvas } from "./context";
import { EdgeInsertButton, useEdgeHover } from "./EdgeInsert";
import { edgePath, type Point } from "./edge-path";
import type { SfEdge } from "./flow";
import { PORTS } from "./geometry";
import { isNodeSelected } from "./selection";
import { LOD_HIDDEN, ZOOM_TEXT_12 } from "./zoom-text";

/**
 * 链连线与调度连线。端点 = 节点位置 + geometry.ts 的端口偏移。选中节点相关的连线（或选中的连线本身）
 * 改成选中色，虚线流动两个周期后停住。运行状态下画成线路图（decorateEdge，见 context.ts 的 EdgeDecoration）：
 * 走过的路段变亮变粗，还没走到的暗灰，进入执行中节点的青色、失败节点的红色、等待中节点的琥珀色，都是实线、不降不透明度；
 * 子流程结束后调度连线和「◆ 调度」标签变灰。选中时只加粗，颜色保持：执行信号不被选中覆盖。
 * 线宽不随视图缩放：缩小到 0.3 时屏幕上仍是 1.5px（运行状态下 2px）。
 * 可编辑时，悬停链上的连线在中点出现「＋」（EdgeInsert.tsx）；连线时（拖线、改接）不出现。
 */
export function FlowEdge({ id, source, target, selected, data }: EdgeProps<SfEdge>) {
	const { selection, decorateEdge, insertOnEdge, openEdgeMenu } = useFlowCanvas();
	const hover = useEdgeHover();
	const connecting = useStore((s) => s.connection.inProgress);
	const from = useInternalNode(source)?.internals.positionAbsolute;
	const to = useInternalNode(target)?.internals.positionAbsolute;
	if (!from || !to) return null;
	const kind = data?.kind ?? "chain";
	const start = kind === "dispatch" ? PORTS.dispatch : PORTS.out;
	const p1: Point = [from.x + start.x, from.y + start.y];
	const p2: Point = [to.x + PORTS.in.x, to.y + PORTS.in.y];
	const { d, mid, center } = edgePath(kind, p1, p2);
	const highlighted =
		selected || isNodeSelected(selection, source) || isNodeSelected(selection, target);
	const run = decorateEdge?.({ from: source, to: target, kind });
	return (
		<>
			<path
				d={d}
				data-edge={id}
				data-highlighted={highlighted}
				data-run={run}
				className={cn(
					"fill-none stroke-canvas-edge stroke-[length:max(1.5px,calc(1.5px/var(--canvas-zoom)))]",
					kind === "dispatch" && "stroke-signal-line [stroke-dasharray:4_4]",
					// 调度连线：子流程结束后变灰，青色只留给正在发生的调度。
					kind === "dispatch" && run === "ended" && "stroke-canvas-edge",
					// 线路图（链连线）
					kind === "chain" && run && "stroke-[length:max(2px,calc(2px/var(--canvas-zoom)))]",
					kind === "chain" && run === "travelled" && "stroke-canvas-edge-travelled",
					kind === "chain" && run === "ahead" && "stroke-canvas-edge-ahead",
					kind === "chain" && run === "live" && "stroke-canvas-edge-live",
					kind === "chain" && run === "failed" && "stroke-danger-line",
					kind === "chain" && run === "waiting" && "stroke-warn-line",
					highlighted &&
						!run &&
						"stroke-canvas-edge-selected [stroke-dasharray:6_5] motion-safe:[animation:edge-flow_1s_linear_2]",
					highlighted && run && "stroke-[length:max(2.5px,calc(2.5px/var(--canvas-zoom)))]",
				)}
			/>
			{/* 加宽的透明路径，便于点选连线 */}
			<path
				d={d}
				fill="none"
				stroke="transparent"
				strokeWidth={14}
				className="react-flow__edge-interaction"
				ref={hover.bind}
			/>
			{insertOnEdge && center && hover.hovered && !connecting && (
				<EdgeInsertButton
					at={center}
					hover={hover}
					onInsert={(client) => insertOnEdge({ from: source, to: target }, client)}
					onMenu={(client) => openEdgeMenu?.({ from: source, to: target, kind }, client)}
				/>
			)}
			{mid && (
				<EdgeLabelRenderer>
					<div
						className={cn(
							"absolute rounded-md border border-signal-line bg-canvas-bg px-1.75 font-mono leading-4 whitespace-nowrap text-signal-fg",
							// 子流程结束后标签和虚线一起变灰。
							run === "ended" && "border-border-strong text-fg-3",
							ZOOM_TEXT_12,
							// 缩小看全图时不写字：调度连线是虚线、调度端口是菱形，已经认得出；字和卡片标题一样大，只会抢眼。
							LOD_HIDDEN,
						)}
						data-dispatch-label={run ?? "idle"}
						style={{ transform: `translate(8px, -50%) translate(${mid[0]}px, ${mid[1]}px)` }}
					>
						◆ 调度
					</div>
				</EdgeLabelRenderer>
			)}
		</>
	);
}

export const edgeTypes = { sf: FlowEdge };
