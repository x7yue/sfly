import { EdgeLabelRenderer, type EdgeProps, useInternalNode, useStore } from "@xyflow/react";
import { cn } from "cn";
import { useFlowCanvas } from "./context";
import { EdgeInsertButton, useEdgeHover } from "./EdgeInsert";
import type { SfEdge } from "./flow";
import { PORTS } from "./geometry";
import { isNodeSelected } from "./selection";
import { ZOOM_TEXT_12 } from "./zoom-text";

type Point = [number, number];

function cubic([p0, p1, p2, p3]: [Point, Point, Point, Point], t: number): Point {
	const u = 1 - t;
	const f = (i: 0 | 1) =>
		u * u * u * p0[i] + 3 * u * u * t * p1[i] + 3 * u * t * t * p2[i] + t * t * t * p3[i];
	return [f(0), f(1)];
}

/**
 * 连线路径（原型 edgesSVG）：
 * - 调度连线：从异步任务节点底部竖直落下，再水平进入子流程入口节点的左侧端口，中段标「◆ 调度」；
 * - 链连线同一行：直线；换行或回绕：从起点右侧拐到两行之间，再从目标左侧进入；
 * - 其余：水平贝塞尔。
 */
export function edgePath(
	kind: "chain" | "dispatch",
	[x1, y1]: Point,
	[x2, y2]: Point,
): { d: string; mid?: Point } {
	if (kind === "dispatch") {
		const r = Math.min(24, Math.max(0, y2 - y1));
		if (x2 - x1 >= r + 8 && r > 0) {
			// 竖直落下，转一个圆角后水平进入子流程入口。
			return {
				d: `M${x1} ${y1} L${x1} ${y2 - r} Q${x1} ${y2} ${x1 + r} ${y2} L${x2} ${y2}`,
				mid: [x1, y1 + (y2 - r - y1) * 0.4],
			};
		}
		const c: [Point, Point, Point, Point] = [
			[x1, y1],
			[x1, y2 - 40],
			[x2 - 80, y2],
			[x2, y2],
		];
		return {
			d: `M${x1} ${y1} C${x1} ${y2 - 40}, ${x2 - 80} ${y2}, ${x2} ${y2}`,
			mid: cubic(c, 0.5),
		};
	}
	if (Math.abs(y2 - y1) < 1 && x2 >= x1) return { d: `M${x1} ${y1} L${x2} ${y2}` };
	if (x2 < x1 + 40) {
		const ym = (y1 + y2) / 2;
		const r = 46;
		return {
			d: `M${x1} ${y1} C${x1 + r} ${y1}, ${x1 + r} ${ym}, ${x1} ${ym} L${x2} ${ym} C${x2 - r} ${ym}, ${x2 - r} ${y2}, ${x2} ${y2}`,
		};
	}
	const c = Math.max(30, (x2 - x1) * 0.5);
	return { d: `M${x1} ${y1} C${x1 + c} ${y1}, ${x2 - c} ${y2}, ${x2} ${y2}` };
}

/**
 * 链连线与调度连线。端点 = 节点位置 + geometry.ts 的端口偏移。选中节点相关的连线（或选中的连线本身）
 * 改成选中色，虚线流动两个周期后停住；decorateEdge 给出的运行状态：live 青色实线、failed 红色，
 * 选中时只加粗，颜色保持：执行信号不被选中覆盖。线宽不随视图缩放：缩小到 0.3 时屏幕上仍是 1.5px。
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
	const { d, mid } = edgePath(kind, p1, p2);
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
					run === "live" &&
						"stroke-canvas-edge-live stroke-[length:max(1.75px,calc(1.75px/var(--canvas-zoom)))] [stroke-dasharray:none]",
					run === "failed" && "stroke-canvas-run-failed opacity-70",
					highlighted &&
						!run &&
						"stroke-canvas-edge-selected opacity-100 [stroke-dasharray:6_5] motion-safe:[animation:edge-flow_1s_linear_2]",
					highlighted &&
						run &&
						"stroke-[length:max(2.25px,calc(2.25px/var(--canvas-zoom)))] opacity-100",
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
			{insertOnEdge && kind === "chain" && hover.hovered && !connecting && (
				// 链连线的路径关于中点对称（直线、贝塞尔、换行的折返都是），中点就是两端的中点。
				<EdgeInsertButton
					at={[(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2]}
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
							ZOOM_TEXT_12,
						)}
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
