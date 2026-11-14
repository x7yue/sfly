import type { Position } from "@sfly/orchestration";
import { type NodeChange, useStoreApi } from "@xyflow/react";
import { type MouseEvent, type PointerEvent, useRef } from "react";
import type { SfNode } from "./flow";

/** 指针移动超过这么多屏幕像素才算拖动：之下是点击，手抖不会挪动成员，也不进撤销栈。 */
const DRAG_THRESHOLD = 3;

/** 注释框的标题带拖动时移动谁、怎么报告。 */
export interface BandDrag {
	/** 一起移动的节点：注释框的全部成员（子流程成员的整条链在内）。 */
	members: readonly string[];
	/** 画布上全部节点现在的位置（画布坐标）。 */
	positions: ReadonlyMap<string, Position>;
	/** 和 React Flow 拖动节点一样用位置变化报告（拖动中 `dragging` 为 true，松手时为 false）。 */
	onMove(changes: NodeChange<SfNode>[]): void;
}

interface Gesture {
	pointerId: number;
	/** 按下时的屏幕坐标。 */
	x: number;
	y: number;
	zoom: number;
	/** 按下时成员的位置：之后每次都按总位移从这里算，不累加。 */
	starts: ReadonlyMap<string, Position>;
	moved: boolean;
	/** 到现在为止的总位移（画布坐标）。 */
	delta: Position;
}

const positionChanges = (
	starts: ReadonlyMap<string, Position>,
	delta: Position,
	dragging: boolean,
): NodeChange<SfNode>[] =>
	[...starts].map(([id, at]) => ({
		type: "position",
		id,
		position: { x: at.x + delta.x, y: at.y + delta.y },
		dragging,
	}));

/**
 * 拖动注释框的标题带，整组成员一起移动（画布上拖动节点的手势：按下、移动、松开；一次拖动在撤销栈里是一步）。
 * 拖动之后紧跟着的那一下 click 不再当成点击选中。没给 `drag` 时什么也不做。
 */
export function useBandDrag(drag: BandDrag | undefined) {
	const store = useStoreApi();
	const gesture = useRef<Gesture | null>(null);
	const afterDrag = useRef(false);
	if (!drag) return {};

	const end = (event: PointerEvent) => {
		const g = gesture.current;
		if (!g || g.pointerId !== event.pointerId) return;
		gesture.current = null;
		if (!g.moved) return;
		afterDrag.current = true;
		drag.onMove(positionChanges(g.starts, g.delta, false));
	};

	return {
		onPointerDown(event: PointerEvent<HTMLElement>) {
			afterDrag.current = false;
			if (event.button !== 0 || !event.isPrimary) return;
			gesture.current = {
				pointerId: event.pointerId,
				x: event.clientX,
				y: event.clientY,
				zoom: store.getState().transform[2],
				starts: new Map(
					drag.members.flatMap((id) => {
						const at = drag.positions.get(id);
						return at ? [[id, at] as const] : [];
					}),
				),
				moved: false,
				delta: { x: 0, y: 0 },
			};
			event.currentTarget.setPointerCapture(event.pointerId);
		},
		onPointerMove(event: PointerEvent) {
			const g = gesture.current;
			if (!g || g.pointerId !== event.pointerId) return;
			const dx = event.clientX - g.x;
			const dy = event.clientY - g.y;
			if (!g.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
			g.moved = true;
			g.delta = { x: dx / g.zoom, y: dy / g.zoom };
			drag.onMove(positionChanges(g.starts, g.delta, true));
		},
		onPointerUp: end,
		onPointerCancel: end,
		onLostPointerCapture: end,
		onClickCapture(event: MouseEvent) {
			if (!afterDrag.current) return;
			afterDrag.current = false;
			event.stopPropagation();
		},
	};
}
