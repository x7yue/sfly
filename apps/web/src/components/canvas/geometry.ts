import { NODE_SIZE, REGION_PADDING } from "@sfly/orchestration";

/**
 * 画布的几何常量——唯一来源（#35）。节点卡片的尺寸、端口位置、连线端点、子流程区域的留白、
 * 缩放范围都从这里取；卡片和端口的尺寸以内联样式写入 DOM，
 * 连线端点由节点位置加这里的端口偏移算出（不依赖测量到的端口位置）。
 * 卡片尺寸与子流程区域留白来自整理布局算法（@sfly/orchestration 的 layout.ts，控制面也用它排初始布局）。
 */

/** 节点卡片（原型 `.n`）。 */
export const NODE_WIDTH = NODE_SIZE.width;
export const NODE_HEIGHT = NODE_SIZE.height;
/** 卡片圆角：设计体系的 `rounded-lg`（8px）。 */
export const NODE_RADIUS = 8;

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
export { REGION_PADDING };

/**
 * 缩放范围。下限 0.3：再小时语义缩放后的标题（屏幕上 12px）在卡片里放不下；
 * 打开时自动适配视图最多放大到 1。
 */
export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 2;
export const FIT_MAX_ZOOM = 1;

/**
 * 语义缩放阈值：缩放比例低于它时卡片只保留 ID、标题和状态。高于它时文字也会随缩小而在世界坐标里放大
 * （zoom-text.ts），屏幕上不小于 11px（数字与拉丁字母）、12px（中文）；阈值取在放大后的文字还放得进卡片的位置。
 */
export const LOD_THRESHOLD = 0.75;

/** 悬浮控件与视口边缘的间距。 */
export const FLOAT_GAP = 12;

export const MINIMAP_SIZE = { width: 188, height: 118 } as const;

/** 底部工具条在编辑模式下的宽度（量出来的），e2e（panel-resize.spec.ts）检查它不会超过这个值。 */
export const DOCK_WIDTH = 506;

export const INSPECTOR_MARGIN = 12;

/** 检查器最宽时要给画布留出的宽度：除了检查器，画布至少要放下小地图、工具条和间距，否则工具条会压住小地图。 */
export const INSPECTOR_CANVAS_RESERVE =
	FLOAT_GAP + MINIMAP_SIZE.width + FLOAT_GAP + DOCK_WIDTH + FLOAT_GAP + INSPECTOR_MARGIN;

/** 视口四周被悬浮控件占住的区域（px）：适配视图、键盘定位节点时避开。 */
export interface CanvasInsets {
	top: number;
	right: number;
	bottom: number;
	left: number;
}

/**
 * 连线两端改接用的拖动区半径（React Flow 的 reconnectRadius，圆贴在端口外侧）与连线中点「＋」的直径。
 * 默认布局里同一行相邻两个节点之间的连线只有 44（列距 252 − 卡片宽 208），去掉两个端口各露出的半个直径还剩 35：
 * 两端各 14 的拖动区加中间 14 的「＋」，彼此只重叠约 3.5，两端都还能按到。
 */
export const RECONNECT_RADIUS = 7;
export const EDGE_INSERT_SIZE = 14;
