import type { Position } from "@sfly/orchestration";
import { EdgeLabelRenderer } from "@xyflow/react";
import { PlusIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { EDGE_INSERT_SIZE } from "./geometry";

/** 鼠标离开连线后「＋」还留多久：从连线移到「＋」上时不闪掉。 */
const LINGER_MS = 150;

/**
 * 连线的悬停状态：整条连线（React Flow 包在外面的 `.react-flow__edge`，含加宽的透明路径和两端改接用的拖动区）
 * 和中点的「＋」共用。默认布局里连线很短，大半被两端的拖动区盖住，所以挂在外层而不是只挂在路径上。
 * 「＋」不在连线的 SVG 里（EdgeLabelRenderer），鼠标从连线移到「＋」上会先离开再进入，所以离开后稍等一会儿再收起。
 * `bind` 作为连线里任一元素的 ref。
 */
export function useEdgeHover() {
	const [hovered, setHovered] = useState(false);
	const timer = useRef<number | undefined>(undefined);
	const enter = useCallback(() => {
		window.clearTimeout(timer.current);
		setHovered(true);
	}, []);
	const leave = useCallback(() => {
		window.clearTimeout(timer.current);
		timer.current = window.setTimeout(() => setHovered(false), LINGER_MS);
	}, []);
	const bind = useCallback(
		(el: SVGElement | null) => {
			const edge = el?.closest(".react-flow__edge");
			if (!edge) return;
			edge.addEventListener("mouseenter", enter);
			edge.addEventListener("mouseleave", leave);
			return () => {
				edge.removeEventListener("mouseenter", enter);
				edge.removeEventListener("mouseleave", leave);
			};
		},
		[enter, leave],
	);
	useEffect(() => () => window.clearTimeout(timer.current), []);
	return { hovered, enter, leave, bind };
}

/**
 * 链上连线中点的「＋」（悬停时出现）：点它等同于连线菜单的「在此插入节点」，添加节点菜单出现在它下方；
 * 在它上面右键打开连线菜单（它盖住了连线的中段）。
 */
export function EdgeInsertButton({
	at: [x, y],
	hover,
	onInsert,
	onMenu,
}: {
	/** 中点的画布坐标。 */
	at: [number, number];
	hover: ReturnType<typeof useEdgeHover>;
	onInsert(client: Position): void;
	onMenu(client: Position): void;
}) {
	return (
		<EdgeLabelRenderer>
			<button
				type="button"
				aria-label="在此插入节点"
				// nodrag / nopan：按在「＋」上不拖动画布。
				className="nodrag nopan pointer-events-auto absolute top-0 left-0 grid cursor-pointer place-items-center rounded-full border border-border-strong bg-raised-2 text-fg-1 shadow-float hover:bg-raised [&_svg]:size-2.5"
				style={{
					width: EDGE_INSERT_SIZE,
					height: EDGE_INSERT_SIZE,
					transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
				}}
				onMouseEnter={hover.enter}
				onMouseLeave={hover.leave}
				onClick={(event) => {
					const box = event.currentTarget.getBoundingClientRect();
					onInsert({ x: box.left, y: box.bottom });
				}}
				onContextMenu={(event) => {
					event.preventDefault();
					onMenu({ x: event.clientX, y: event.clientY });
				}}
			>
				<PlusIcon />
			</button>
		</EdgeLabelRenderer>
	);
}
