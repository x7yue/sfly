import { FIT_MAX_ZOOM, READABLE_ZOOM } from "./geometry";

export interface Bounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface Viewport {
	x: number;
	y: number;
	zoom: number;
}

/** 视口四周被悬浮控件占住的区域（px）。 */
interface Area {
	top: number;
	right: number;
	bottom: number;
	left: number;
}

/** 内容和悬浮控件之间再留的边距（px），和适配视图相同。 */
const MARGIN = { top: 24, right: 24, bottom: 16, left: 24 } as const;

/**
 * 整理布局之后的视图：整张图在看得清的大小（READABLE_ZOOM）放得下时整张放进视口居中，最多放大到 100%；
 * 放不下时缩到看得清的大小，放不下的方向从左上角（主链开头）开始显示，放得下的方向居中。
 * `bounds` 是节点、子流程区域和注释框合起来的范围（画布坐标），`view` 是画布在屏幕上的大小。
 */
export function readableViewport(
	bounds: Bounds,
	view: { width: number; height: number },
	area: Area,
): Viewport {
	const left = area.left + MARGIN.left;
	const top = area.top + MARGIN.top;
	const width = view.width - left - area.right - MARGIN.right;
	const height = view.height - top - area.bottom - MARGIN.bottom;
	const fit = Math.min(width / bounds.width, height / bounds.height);
	const zoom = Math.min(FIT_MAX_ZOOM, Math.max(fit, READABLE_ZOOM));
	const place = (start: number, room: number, from: number, size: number) =>
		size * zoom <= room ? start + (room - size * zoom) / 2 - from * zoom : start - from * zoom;
	return {
		x: place(left, width, bounds.x, bounds.width),
		y: place(top, height, bounds.y, bounds.height),
		zoom,
	};
}
