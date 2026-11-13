/**
 * 画布视口的动画（适配视图、定位节点、缩放按钮）由 xyflow 的 d3-zoom 在 JS 里逐帧驱动，CSS 的「减少动效」管不到。
 * 平移加缩放是大面积的双轴运动，最容易引起不适：系统开启「减少动效」时直接跳到终点。
 * 时长与动效 token 一致（`--motion-slow` 200ms，缩放按钮 `--motion-base` 150ms，见 docs/DESIGN-SYSTEM.md「动效」）。
 */
const reduced =
	typeof window !== "undefined" && typeof window.matchMedia === "function"
		? window.matchMedia("(prefers-reduced-motion: reduce)")
		: null;

/** 视口动画的时长（毫秒）：开启「减少动效」时为 0。每次调用时读取，系统设置变了立即生效。 */
export const viewportDuration = (ms: number) => (reduced?.matches ? 0 : ms);

export const VIEWPORT_MS = 200;
