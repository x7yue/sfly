import type { LastRunNodeStatus, OrchestrationStructure } from "@sfly/schema";
import { useMemo } from "react";
import { STATUS } from "#/components/status";
import { layoutThumbnail } from "./thumbnail";

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
			data-viz
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
			{t.nodes.map((n) => {
				const { area } = STATUS[n.state];
				const inset = area.tall ? 0 : n.h / 8;
				return (
					<rect
						key={n.id}
						data-node={n.id}
						data-state={n.state}
						x={n.x}
						y={n.y + inset}
						width={n.w}
						height={n.h - 2 * inset}
						rx={n.h > 16 ? 4 : 3}
						strokeWidth={1.2}
						className={area.svg}
					/>
				);
			})}
		</svg>
	);
}
