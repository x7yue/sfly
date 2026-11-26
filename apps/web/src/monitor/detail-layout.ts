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
 * 为了让第一张图表整张露出来，底部面板在窗口很矮时再让到的下限（px）：比 {@link PANEL_FLOOR} 低 20px，只在
 * {@link chartsReservedHeight} 算「让得出来多少」时用（1600×700 里时间线已经在最矮，面板 190px 时第一张图表差 20px 露不全，
 * 170px 的面板仍放得下标签行、几行日志和输入输出的第一块）。窗口高的时候用不到：时间线先让，面板仍是 {@link PANEL_FLOOR} 以上。
 */
export const PANEL_SQUEEZE_FLOOR = 170;

/**
 * 时间线主体最高的高度（px）：`available` 是详情的可用高度（失败横幅以下，时间线、图表、面板共用的高度），
 * `chartsReserved` 是图表工作区要留的高度。
 */
export const timelineBodyMax = (available: number, chartsReserved: number): number =>
	Math.max(TIMELINE_BODY_MIN, available - TIMELINE_HEADER_HEIGHT - chartsReserved - PANEL_FLOOR);

/**
 * 图表工作区最少的高度（px，大约是工具栏）：窗口矮到连 {@link CHARTS_RESERVED_HEIGHT} 也放不下时，图表最后让到这里，
 * 滚动查看，时间线、图表、底部面板总在窗口里。
 */
export const CHARTS_MIN_HEIGHT = 48;

/**
 * 图表工作区预留的高度（px）的下限：窗口变矮（1280×800 带失败横幅）、底部面板被拖高时，先压底部面板，图表工作区至少有这么高
 * （内容不够这么高时只留内容的高度，不留空白）。够放下工具栏、一个图表组的标题和节点摘要，加上一张 136px 高的图表
 * 的绝大部分。第一张图表被推得更低时按 {@link chartsReservedHeight} 往上加。依据和实测写在 docs/DESIGN-SYSTEM.md 的「运行监控详情的竖直分配」。
 */
export const CHARTS_RESERVED_HEIGHT = 300;

/** 窄窗口（工具栏折成几行）里第一张图表至少露出这么多（px）：以前窄窗口的预留规则，现在是预留的下限之一。 */
export const CHARTS_VISIBLE_FIGURE = 120;

/** 第一张图表（含标题、图例，整张）要露出的份额：露出 96% 以上，整张图的下沿描边之外的留白不算。 */
export const CHARTS_FIRST_VISIBLE = 0.96;

/** 第一张图表在图表工作区里的位置（px）：上沿离滚动区域顶端多远（选中节点的组滚到顶端以后的位置）、它自己的高度。 */
export interface FirstChart {
	top: number;
	height: number;
}

/**
 * 图表工作区要预留的高度（px）：底部面板最高到「图表工作区和底部面板共有的高度」减去它，时间线主体最高也据此让
 * （{@link timelineBodyMax}）。
 *
 * - 下限是 {@link CHARTS_RESERVED_HEIGHT}；窗口窄于 1280px 时工具栏折成几行、节点摘要折行，第一张图表被推下去，
 *   下限再加到第一张图表的上沿加 {@link CHARTS_VISIBLE_FIGURE}（以前就是这样）。
 * - 想要的是第一张图表（选中节点时是它的组里那一张）露出 {@link CHARTS_FIRST_VISIBLE}：上沿加这份高度。选中节点的摘要
 *   （状态、Agent、总耗时，失败时还有错误）在图表上面，会把图表推下去，只留 300px 时图表的下半截被图表区的下沿截掉。
 * - 想要的不超过「时间线退到最矮（{@link TIMELINE_BODY_MIN}）、面板退到 {@link PANEL_SQUEEZE_FLOOR} 之后剩下的」：
 *   窗口高的时候时间线和面板先让（面板的默认高度就是让出来的；时间线先让，所以面板在 {@link PANEL_FLOOR} 以上，
 *   只有时间线已经最矮、还差一点才再压面板），窗口矮到让不出来，就留以前的下限，不再往上加。
 *
 * `first` 是 null（没有图表）时只有下限；`available` 是详情的可用高度（窗口减顶栏、失败横幅，量出来之前是 0）。
 */
export function chartsReservedHeight(
	first: FirstChart | null,
	available: number,
	narrow: boolean,
): number {
	if (!first) return CHARTS_RESERVED_HEIGHT;
	const floor = narrow
		? Math.max(CHARTS_RESERVED_HEIGHT, first.top + CHARTS_VISIBLE_FIGURE)
		: CHARTS_RESERVED_HEIGHT;
	const wanted = first.top + Math.ceil(first.height * CHARTS_FIRST_VISIBLE);
	const room = available - TIMELINE_HEADER_HEIGHT - TIMELINE_BODY_MIN - PANEL_SQUEEZE_FLOOR;
	return Math.max(floor, Math.min(wanted, room));
}
