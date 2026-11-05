/**
 * 画布的几何常量——唯一来源（#35）。节点卡片的尺寸、端口位置、连线端点、子流程区域的留白、
 * 没有布局的节点的默认间距、缩放范围都从这里取；卡片和端口的尺寸以内联样式写入 DOM，
 * 连线端点由节点位置加这里的端口偏移算出（不依赖测量到的端口位置）。
 */

/** 节点卡片（原型 `.n`）。 */
export const NODE_WIDTH = 208;
export const NODE_HEIGHT = 112;
export const NODE_RADIUS = 10;

/** 端口直径（圆点；调度端口是旋转 45° 的方块，外接框同宽）。 */
export const PORT_SIZE = 9;

/** 端口中心相对节点左上角的位置。 */
export const PORTS = {
	/** 链入口：左侧中点（子流程入口节点在同一位置接收调度连线）。 */
	in: { x: 0, y: NODE_HEIGHT / 2 },
	/** 链出口：右侧中点。 */
	out: { x: NODE_WIDTH, y: NODE_HEIGHT / 2 },
	/** 调度出口：异步任务节点底边中点。 */
	dispatch: { x: NODE_WIDTH / 2, y: NODE_HEIGHT },
} as const;

/** 子流程区域在成员节点外接框之外的留白；上方留出标题行。 */
export const REGION_PADDING = { left: 24, top: 44, right: 24, bottom: 20 } as const;

/** 没有布局的节点按顺序横向排开的间距（编排文档 → 画布）。 */
export const DEFAULT_NODE_SPACING = NODE_WIDTH + 44;

/**
 * 缩放范围。下限 0.3：再小时语义缩放后的标题（屏幕上 11–12px）在卡片里放不下；
 * 打开时自动适配视图最多放大到 1。
 */
export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 2;
export const FIT_MAX_ZOOM = 1;

/**
 * 语义缩放阈值：缩放比例低于它时卡片只保留 ID、标题和状态。高于它时文字也会随缩小而在世界坐标里放大
 * （zoom-text.ts），屏幕上不小于 11px；阈值取在放大后的文字还放得进卡片的位置。
 */
export const LOD_THRESHOLD = 0.75;

/** 画布上任何文字在屏幕上的最小字号（px）。 */
export const MIN_SCREEN_TEXT = 11;

/** 悬浮控件与视口边缘的间距。 */
export const FLOAT_GAP = 12;

/** 视口四周被悬浮控件占住的区域（px）：适配视图、键盘定位节点时避开。 */
export interface CanvasInsets {
	top: number;
	right: number;
	bottom: number;
	left: number;
}
