import { CHAIN_WRAP_DROP, REGION_PADDING } from "@sfly/orchestration";

export type Point = [number, number];

/** 往下换行的连线在目标左侧多远处竖直落下：注释框左边留白 24 之外再留 16。 */
const WRAP_LEFT = REGION_PADDING.left + 16;
/** 换行连线拐角的半径。 */
const WRAP_TURN = 12;

function cubic([p0, p1, p2, p3]: [Point, Point, Point, Point], t: number): Point {
	const u = 1 - t;
	const f = (i: 0 | 1) =>
		u * u * u * p0[i] + 3 * u * u * t * p1[i] + 3 * u * t * t * p2[i] + t * t * t * p3[i];
	return [f(0), f(1)];
}

/**
 * 连线路径（原型 edgesSVG）：
 * - 调度连线：从异步任务节点底部竖直落下，再水平进入子流程入口节点的左侧端口，中段标「◆ 调度」；
 * - 链连线同一行：直线；往下换行：从起点右侧拐到上一行下方 CHAIN_WRAP_DROP 处，往左绕到目标所在注释框的框外，
 *   竖直落下后水平进入目标；其余回绕：从起点右侧拐到两端之间，再从目标左侧进入；
 * - 其余：水平贝塞尔。
 *
 * `mid` 是调度连线标签的位置；`center` 是链连线上「＋」的位置（换行连线取折回的那段水平线的中点）。
 */
export function edgePath(
	kind: "chain" | "dispatch",
	[x1, y1]: Point,
	[x2, y2]: Point,
): { d: string; mid?: Point; center?: Point } {
	if (kind === "dispatch") {
		const r = Math.min(24, Math.max(0, y2 - y1));
		if (x2 - x1 >= r + 8 && r > 0) {
			// 竖直落下，转一个圆角后水平进入子流程入口。
			return {
				d: `M${x1} ${y1} L${x1} ${y2 - r} Q${x1} ${y2} ${x1 + r} ${y2} L${x2} ${y2}`,
				mid: [x1, y1 + (y2 - r - y1) * 0.4],
			};
		}
		const c: [Point, Point, Point, Point] = [
			[x1, y1],
			[x1, y2 - 40],
			[x2 - 80, y2],
			[x2, y2],
		];
		return {
			d: `M${x1} ${y1} C${x1} ${y2 - 40}, ${x2 - 80} ${y2}, ${x2} ${y2}`,
			mid: cubic(c, 0.5),
		};
	}
	const middle: Point = [(x1 + x2) / 2, (y1 + y2) / 2];
	if (Math.abs(y2 - y1) < 1 && x2 >= x1) return { d: `M${x1} ${y1} L${x2} ${y2}`, center: middle };
	if (x2 < x1 + 40) {
		const r = 46;
		if (y2 > y1 + 2 * WRAP_TURN) {
			// 往下换行：从起点右侧拐下来，在上一行下方 CHAIN_WRAP_DROP 处（夹着子流程时也贴着上一行）往左走到
			// 目标左侧 WRAP_LEFT 之外，竖直落下，再水平进入目标：竖线在目标所在注释框的框外，不压住框的标题。
			const ym = y1 + Math.min((y2 - y1) / 2, CHAIN_WRAP_DROP);
			const xl = x2 - WRAP_LEFT;
			const k = WRAP_TURN;
			return {
				d: `M${x1} ${y1} C${x1 + r} ${y1}, ${x1 + r} ${ym}, ${x1} ${ym} L${xl + k} ${ym} Q${xl} ${ym} ${xl} ${ym + k} L${xl} ${y2 - k} Q${xl} ${y2} ${xl + k} ${y2} L${x2} ${y2}`,
				center: [(x1 + x2) / 2, ym],
			};
		}
		const ym = (y1 + y2) / 2;
		return {
			d: `M${x1} ${y1} C${x1 + r} ${y1}, ${x1 + r} ${ym}, ${x1} ${ym} L${x2} ${ym} C${x2 - r} ${ym}, ${x2 - r} ${y2}, ${x2} ${y2}`,
			center: [(x1 + x2) / 2, ym],
		};
	}
	const c = Math.max(30, (x2 - x1) * 0.5);
	return { d: `M${x1} ${y1} C${x1 + c} ${y1}, ${x2 - c} ${y2}, ${x2} ${y2}`, center: middle };
}
