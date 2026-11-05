import { EdgeLabelRenderer, type EdgeProps, useInternalNode } from "@xyflow/react";
import { cn } from "cn";
import type { SfEdge } from "#/canvas/flow";
import { useFlowCanvas } from "./context";
import { PORTS } from "./geometry";
import { ZOOM_TEXT_11 } from "./zoom-text";

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
 * 灰色虚线流动；decorateEdge 给出的运行状态：live 青色实线、failed 红色。
 */
export function FlowEdge({ id, source, target, selected, data }: EdgeProps<SfEdge>) {
	const { selectedId, decorateEdge } = useFlowCanvas();
	const from = useInternalNode(source)?.internals.positionAbsolute;
	const to = useInternalNode(target)?.internals.positionAbsolute;
	if (!from || !to) return null;
	const kind = data?.kind ?? "chain";
	const start = kind === "dispatch" ? PORTS.dispatch : PORTS.out;
	const { d, mid } = edgePath(
		kind,
		[from.x + start.x, from.y + start.y],
		[to.x + PORTS.in.x, to.y + PORTS.in.y],
	);
	const highlighted = selected || selectedId === source || selectedId === target;
	const run = decorateEdge?.({ from: source, to: target, kind });
	return (
		<>
			<path
				d={d}
				data-edge={id}
				data-highlighted={highlighted}
				data-run={run}
				className={cn(
					"fill-none stroke-canvas-edge stroke-[1.5]",
					kind === "dispatch" && "stroke-signal-line [stroke-dasharray:4_4]",
					run === "live" && "stroke-canvas-edge-live stroke-[1.75] [stroke-dasharray:none]",
					run === "failed" && "stroke-canvas-run-failed opacity-70",
					highlighted &&
						"animate-edge-flow stroke-canvas-edge-selected opacity-100 [stroke-dasharray:6_5]",
				)}
			/>
			{/* 加宽的透明路径，便于点选连线 */}
			<path
				d={d}
				fill="none"
				stroke="transparent"
				strokeWidth={14}
				className="react-flow__edge-interaction"
			/>
			{mid && (
				<EdgeLabelRenderer>
					<div
						className={cn(
							"absolute rounded-md border border-signal-line bg-canvas-bg px-1.75 font-mono leading-4 whitespace-nowrap text-signal-fg",
							ZOOM_TEXT_11,
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
