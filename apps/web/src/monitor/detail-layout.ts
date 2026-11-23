/**
 * 运行监控详情的竖直分配（docs/DESIGN-SYSTEM.md 6.7）里和时间线有关的几个数。
 * 时间线主体默认最高占视口的 30%（`TIMELINE_BODY_MAX`）；窗口矮的时候，它不能把图表和底部面板的位置占走：
 * 主体最高是「详情的可用高度（窗口减顶栏、失败横幅）减去时间线的标题行、图表要留的高度和底部面板的下限」之后剩下的
 * （`timelineBodyMax`），最少 `TIMELINE_BODY_MIN`。窗口高的时候这个剩下的比 30% 大，不起作用，时间线和以前一样。
 */

/** 时间线标题行（缩放、实时跟随、收起）的高度（px）。 */
export const TIMELINE_HEADER_HEIGHT = 40;

/** 时间线主体的默认上限：视口的 30%，至少 150px、最多 420px（拖动调高也不超过 420px）。 */
export const TIMELINE_BODY_MAX_PX = 420;
export const TIMELINE_BODY_MAX = `clamp(150px, 30dvh, ${TIMELINE_BODY_MAX_PX}px)`;

/** 窗口再矮，时间线主体也不低于这个高度（px，行多了在里面滚动）。 */
export const TIMELINE_BODY_MIN = 120;

/**
 * 底部面板在窗口矮时的下限（px）：1440×900 和 1280×800 下面板仍不低于它（更矮的窗口里它一直让到标签行）。
 * 取 190px：1280×800 下「动作」页签的表头和第一行要在面板里露出来（实测 168px 时第一行在面板之外），
 * 图表预留（300px）和面板下限定了，剩下的才是时间线的。
 */
export const PANEL_FLOOR = 190;

/**
 * 时间线主体最高的高度（px）：`available` 是详情的可用高度（失败横幅以下，时间线、图表、面板共用的高度），
 * `chartsReserved` 是图表工作区要留的高度。
 */
export const timelineBodyMax = (available: number, chartsReserved: number): number =>
	Math.max(TIMELINE_BODY_MIN, available - TIMELINE_HEADER_HEIGHT - chartsReserved - PANEL_FLOOR);
