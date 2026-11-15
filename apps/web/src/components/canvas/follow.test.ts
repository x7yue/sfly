import { type LayoutDocument, NODE_SIZE, REGION_PADDING } from "@sfly/orchestration";
import { describe, expect, it } from "vitest";
import { FOLLOW_ZOOM, followViewport } from "./follow";

type Rect = { x: number; y: number; width: number; height: number };
type Viewport = { x: number; y: number; zoom: number };

const card = (x: number, y: number): Rect => ({
	x,
	y,
	width: NODE_SIZE.width,
	height: NODE_SIZE.height,
});

/** 主链 entry → a → spawn → c → mid → far 在一行，spawn 调度的子流程 sub → s1 在下面一行；far 在很远的地方。 */
const layout: LayoutDocument = {
	nodes: [
		{ id: "entry", kind: "entry", position: { x: 0, y: 0 } },
		{ id: "a", kind: "package", position: { x: 252, y: 0 } },
		{ id: "spawn", kind: "async", position: { x: 504, y: 0 } },
		{ id: "c", kind: "package", position: { x: 756, y: 0 } },
		{ id: "sub", kind: "subflow_entry", position: { x: 660, y: 230 } },
		{ id: "s1", kind: "package", position: { x: 912, y: 230 } },
		{ id: "mid", kind: "package", position: { x: 1200, y: 0 } },
		{ id: "far", kind: "package", position: { x: 6000, y: 0 } },
	],
	edges: [
		{ from: "entry", to: "a", kind: "chain" },
		{ from: "a", to: "spawn", kind: "chain" },
		{ from: "spawn", to: "c", kind: "chain" },
		{ from: "spawn", to: "sub", kind: "dispatch" },
		{ from: "sub", to: "s1", kind: "chain" },
		{ from: "c", to: "mid", kind: "chain" },
		{ from: "mid", to: "far", kind: "chain" },
	],
};

/** 子流程 sub 的区域：成员 sub、s1 的外接框加上四周留白。 */
const region: Rect = {
	x: 660 - REGION_PADDING.left,
	y: 230 - REGION_PADDING.top,
	width: 912 + NODE_SIZE.width + REGION_PADDING.right - (660 - REGION_PADDING.left),
	height: 230 + NODE_SIZE.height + REGION_PADDING.bottom - (230 - REGION_PADDING.top),
};

const SIZE = { width: 1440, height: 900 };
/** 画布四周被悬浮控件占住的区域：顶栏、右侧的检查器（372 宽加边距）、底部的工具条。 */
const AREA = { top: 72, right: 396, bottom: 72, left: 12 };
/** 没有悬浮控件：只有画布本身。 */
const NO_AREA = { top: 0, right: 0, bottom: 0, left: 0 };

/** 画布上的矩形在屏幕上的位置。 */
const onScreen = (v: Viewport, r: Rect): Rect => ({
	x: r.x * v.zoom + v.x,
	y: r.y * v.zoom + v.y,
	width: r.width * v.zoom,
	height: r.height * v.zoom,
});

const center = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

const visible = (area: typeof AREA) => ({
	x: area.left,
	y: area.top,
	width: SIZE.width - area.left - area.right,
	height: SIZE.height - area.top - area.bottom,
});

const inside = (r: Rect, outer: Rect) =>
	r.x >= outer.x - 1e-6 &&
	r.y >= outer.y - 1e-6 &&
	r.x + r.width <= outer.x + outer.width + 1e-6 &&
	r.y + r.height <= outer.y + outer.height + 1e-6;

function frame(running: string[], area = AREA, size = SIZE): Viewport {
	const viewport = followViewport({ running, layout, size, area });
	if (!viewport) throw new Error("没有可框的节点");
	return viewport;
}

describe("跟随执行的镜头框选", () => {
	it("一个执行中的节点：放大到 1，放在可见区域的正中", () => {
		const v = frame(["a"]);
		expect(v.zoom).toBe(1);
		const shown = onScreen(v, card(252, 0));
		const area = visible(AREA);
		expect(center(shown).x).toBeCloseTo(center(area).x, 6);
		expect(center(shown).y).toBeCloseTo(center(area).y, 6);
	});

	it("扣掉右侧检查器的宽度：节点落在检查器左边的可见区域里，检查器越宽越往左", () => {
		const narrow = frame(["a"], { ...AREA, right: 12 });
		const wide = frame(["a"], { ...AREA, right: 600 });
		const at = (v: Viewport) => center(onScreen(v, card(252, 0))).x;
		expect(at(narrow)).toBeCloseTo((AREA.left + SIZE.width - 12) / 2, 6);
		expect(at(wide)).toBeCloseTo((AREA.left + SIZE.width - 600) / 2, 6);
		expect(at(wide)).toBeLessThan(at(narrow));
		const shown = onScreen(wide, card(252, 0));
		expect(shown.x + shown.width).toBeLessThanOrEqual(SIZE.width - 600);
	});

	it("多个执行中的节点：全部框进可见区域，整体居中，缩放介于 0.6 和 1 之间", () => {
		const v = frame(["entry", "mid"]);
		expect(v.zoom).toBeGreaterThan(FOLLOW_ZOOM.min);
		expect(v.zoom).toBeLessThan(FOLLOW_ZOOM.max);
		const [first, second] = [onScreen(v, card(0, 0)), onScreen(v, card(1200, 0))];
		const area = visible(AREA);
		expect(inside(first, area)).toBe(true);
		expect(inside(second, area)).toBe(true);
		const middle = (first.x + second.x + second.width) / 2;
		expect(middle).toBeCloseTo(center(area).x, 6);
	});

	it("子流程里的节点连同它的子流程区域一起框进来", () => {
		const v = frame(["s1"]);
		const shown = onScreen(v, region);
		expect(inside(shown, visible(AREA))).toBe(true);
		expect(center(shown).x).toBeCloseTo(center(visible(AREA)).x, 6);
		expect(center(shown).y).toBeCloseTo(center(visible(AREA)).y, 6);
	});

	it("主链和子流程里同时有执行中的节点：节点卡片和子流程区域都在可见区域里", () => {
		const v = frame(["c", "s1"]);
		const area = visible(AREA);
		expect(inside(onScreen(v, card(756, 0)), area)).toBe(true);
		expect(inside(onScreen(v, region), area)).toBe(true);
	});

	it("缩放下限 0.6：执行中的节点离得很远时不再缩小，整体仍然居中", () => {
		const v = frame(["entry", "far"]);
		expect(v.zoom).toBe(FOLLOW_ZOOM.min);
		const [left, right] = [onScreen(v, card(0, 0)), onScreen(v, card(6000, 0))];
		const middle = (left.x + right.x + right.width) / 2;
		expect(middle).toBeCloseTo(center(visible(AREA)).x, 6);
	});

	it("缩放上限 1：只有一个节点、窗口很大时也不放大", () => {
		const v = frame(["a"], NO_AREA, { width: 4000, height: 3000 });
		expect(v.zoom).toBe(FOLLOW_ZOOM.max);
	});

	it("没有执行中的节点、或节点不在画布上时没有视口", () => {
		expect(followViewport({ running: [], layout, size: SIZE, area: AREA })).toBeNull();
		expect(followViewport({ running: ["gone"], layout, size: SIZE, area: AREA })).toBeNull();
	});

	it("画布上没有的节点不影响其余节点的框选", () => {
		expect(frame(["a", "gone"])).toEqual(frame(["a"]));
	});
});
