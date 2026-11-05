import type { LastRunNodeStatus, OrchestrationStructure } from "@sfly/schema";
import { useMemo } from "react";
import { layoutThumbnail, type ThumbState } from "./thumbnail";

/** 缩略图节点的配色（只用语义层与画布层 token）：成功是压暗的绿、执行中青色描边、失败红、已取消灰色虚线。 */
const NODE: Record<ThumbState, string> = {
	pending: "fill-border-strong",
	done: "fill-ok/40",
	running: "fill-signal stroke-signal-fg",
	failed: "fill-danger",
	cancelled: "fill-raised-2 stroke-cancelled [stroke-dasharray:2_2]",
	skipped: "fill-transparent stroke-border-strong",
	waiting: "fill-warn/45",
};

/** 场景卡片顶部的结构缩略图（按最近一次运行着色）；纯装饰，读屏跳过。 */
export function ScenarioThumbnail({
	structure,
	nodeStates,
}: {
	structure: OrchestrationStructure;
	nodeStates: Record<string, LastRunNodeStatus> | null;
}) {
	const t = useMemo(() => layoutThumbnail(structure, nodeStates), [structure, nodeStates]);
	return (
		<svg
			aria-hidden="true"
			viewBox={`-2 0 ${t.width + 4} ${t.height}`}
			preserveAspectRatio="xMidYMid meet"
			className="block size-full"
		>
			{t.regions.map((r) => (
				<rect
					key={`${r.x}:${r.y}`}
					x={r.x}
					y={r.y}
					width={r.w}
					height={r.h}
					rx={6}
					className="fill-canvas-subflow-soft stroke-canvas-subflow-line [stroke-dasharray:3_3]"
				/>
			))}
			{t.dispatches.map((d) => (
				<path
					key={d}
					d={d}
					className="fill-none stroke-canvas-edge-dispatch opacity-60 [stroke-dasharray:3_3]"
				/>
			))}
			{t.links.map((l) => (
				<line
					key={`${l.x1}:${l.y1}:${l.x2}:${l.y2}`}
					{...l}
					strokeWidth={1.2}
					className="stroke-canvas-edge"
				/>
			))}
			{t.nodes.map((n) => (
				<rect
					key={n.id}
					data-node={n.id}
					data-state={n.state}
					x={n.x}
					y={n.y}
					width={n.w}
					height={n.h}
					rx={n.h > 16 ? 4 : 3}
					strokeWidth={1.2}
					className={NODE[n.state]}
				/>
			))}
		</svg>
	);
}
