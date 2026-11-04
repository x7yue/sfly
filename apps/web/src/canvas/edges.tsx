import { EdgeLabelRenderer, type EdgeProps, useStore } from "@xyflow/react";
import { useContext } from "react";
import { statusTone } from "#/runs/format";
import type { SfEdge } from "./flow";
import { CanvasContext } from "./NodeCard";

type Point = [number, number];

/** 端口半径（canvas.css 中 .sf-port 为 10px）。 */
const PORT_RADIUS = 5;
/**
 * 调度端口是旋转 45° 的 10px 方块：React Flow 用旋转后的外接框定位、却用旋转前的尺寸取底边中点，
 * 这里换算回菱形中心。
 */
const DIAMOND_HALF = PORT_RADIUS * Math.SQRT2;
const DIAMOND_DX = DIAMOND_HALF - PORT_RADIUS;
const DIAMOND_DY = 2 * PORT_RADIUS - DIAMOND_HALF;

/** 三次贝塞尔曲线在 t 处的坐标。 */
function cubic([p0, p1, p2, p3]: [Point, Point, Point, Point], t: number): Point {
	const u = 1 - t;
	const f = (i: 0 | 1) =>
		u * u * u * p0[i] + 3 * u * u * t * p1[i] + 3 * u * t * t * p2[i] + t * t * t * p3[i];
	return [f(0), f(1)];
}

/**
 * 连线路径（与画布原型 core/geometry.js 的 edgePath 一致）：
 * - 调度连线：从异步任务节点底部的调度端口竖直落下，再水平进入子流程入口节点的输入端口；
 * - 链连线回绕：目标在起点左侧时，从起点右侧绕到两行之间，再回到目标左侧；
 * - 其余：水平贝塞尔。
 */
function edgePath(
	kind: "chain" | "dispatch",
	x1: number,
	y1: number,
	x2: number,
	y2: number,
): { d: string; mid?: Point } {
	if (kind === "dispatch") {
		const dy = y2 - y1;
		const c: [Point, Point, Point, Point] = [
			[x1, y1],
			[x1, y1 + dy * 0.62],
			[x2 - 70, y2],
			[x2, y2],
		];
		return {
			d: `M${x1} ${y1} C${x1} ${y1 + dy * 0.62}, ${x2 - 70} ${y2}, ${x2} ${y2}`,
			mid: cubic(c, 0.42),
		};
	}
	if (x2 < x1 - 20) {
		const ym = (y1 + y2) / 2;
		const r = 36;
		return {
			d: `M${x1} ${y1} C${x1 + r} ${y1}, ${x1 + r} ${ym}, ${x1 - 10} ${ym} L${x2 + 10} ${ym} C${x2 - r} ${ym}, ${x2 - r} ${y2}, ${x2} ${y2}`,
		};
	}
	const c = Math.max(30, (x2 - x1) * 0.5);
	return { d: `M${x1} ${y1} C${x1 + c} ${y1}, ${x2 - c} ${y2}, ${x2} ${y2}` };
}

/** 链连线与调度连线：选中连线本身或它两端的某个节点时，显示青色流动虚线。 */
export function SfEdgeView({
	id,
	source,
	target,
	sourceX,
	sourceY,
	targetX,
	targetY,
	selected,
	data,
}: EdgeProps<SfEdge>) {
	const kind = data?.kind ?? "chain";
	// 运行模式（原型 canvas.css 的 .run .edge.done / .live）：已完成 → 已完成为灰色实线，已完成 → 执行中（或失败）为青色实线。
	const run = useContext(CanvasContext).run;
	const from = run ? statusTone(run.get(source)?.status ?? "pending") : undefined;
	const to = run ? statusTone(run.get(target)?.status ?? "pending") : undefined;
	const runState =
		from !== "done"
			? undefined
			: to === "done"
				? "done"
				: to === "current" || to === "failed"
					? "live"
					: undefined;
	const endSelected = useStore(
		(s) => !!(s.nodeLookup.get(source)?.selected || s.nodeLookup.get(target)?.selected),
	);
	// React Flow 给出的是端口外沿的坐标；原型要求连线的起点和终点与端口圆心重合。
	const { d, mid } = edgePath(
		kind,
		kind === "dispatch" ? sourceX + DIAMOND_DX : sourceX - PORT_RADIUS,
		kind === "dispatch" ? sourceY - DIAMOND_DY : sourceY,
		targetX + PORT_RADIUS,
		targetY,
	);
	return (
		<>
			<g
				className={`sf-edge sf-edge--${kind}`}
				data-on={selected || endSelected}
				data-run={runState}
			>
				<path className="sf-edge__base" d={d} />
				<path className="sf-edge__flow" d={d} />
				{/* 加宽的透明路径，便于点选连线 */}
				<path
					d={d}
					fill="none"
					stroke="transparent"
					strokeWidth={14}
					className="react-flow__edge-interaction"
				/>
			</g>
			{mid && (
				<EdgeLabelRenderer>
					<div className="sf-dispatch-tag" style={{ left: mid[0], top: mid[1] }} data-edge={id}>
						◆ 调度
					</div>
				</EdgeLabelRenderer>
			)}
		</>
	);
}

export const edgeTypes = { sf: SfEdgeView };
