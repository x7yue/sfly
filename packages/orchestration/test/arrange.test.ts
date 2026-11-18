import { describe, expect, it } from "vitest";
import { ARRANGE_STEP, arrangeNodes, LAYOUT_COLUMN, NODE_SIZE } from "../src/index.js";

// 排列所选（画布上选中几个节点或一个注释框，工具条上的宫格 / 横向 / 纵向排列）：
// 按阅读顺序（先上后下，同一行从左到右）排，左上角留在原来那组的左上角。

const at = (id: string, x: number, y: number) => ({ id, position: { x, y } });
const placed = (result: Map<string, { x: number; y: number }>) =>
	Object.fromEntries([...result].map(([id, p]) => [id, [p.x, p.y]]));

describe("arrangeNodes", () => {
	it("间距和整理布局一样：横向一列宽，纵向留出一行连线的空", () => {
		expect(ARRANGE_STEP).toEqual({ x: LAYOUT_COLUMN, y: NODE_SIZE.height + 56 });
	});

	it("横向排列：按阅读顺序排成一行，从原来的左上角开始", () => {
		const nodes = [at("c", 600, 300), at("a", 100, 40), at("b", 400, 60), at("d", 90, 320)];
		expect(placed(arrangeNodes(nodes, "row"))).toEqual({
			a: [90, 40],
			b: [90 + LAYOUT_COLUMN, 40],
			d: [90 + 2 * LAYOUT_COLUMN, 40],
			c: [90 + 3 * LAYOUT_COLUMN, 40],
		});
	});

	it("纵向排列：按阅读顺序排成一列（b 只比 a 高 10，和 a 算同一行，排在 a 右边，所以在 a 下面）", () => {
		const nodes = [at("b", 300, 0), at("a", 0, 10), at("c", 0, 500)];
		expect(placed(arrangeNodes(nodes, "column"))).toEqual({
			a: [0, 0],
			b: [0, ARRANGE_STEP.y],
			c: [0, 2 * ARRANGE_STEP.y],
		});
	});

	it("宫格排列：列数是节点数的平方根向上取整，一行排满再换行", () => {
		const nodes = ["a", "b", "c", "d", "e"].map((id, i) => at(id, i * 300, 0));
		expect(placed(arrangeNodes(nodes, "grid"))).toEqual({
			a: [0, 0],
			b: [LAYOUT_COLUMN, 0],
			c: [2 * LAYOUT_COLUMN, 0],
			d: [0, ARRANGE_STEP.y],
			e: [LAYOUT_COLUMN, ARRANGE_STEP.y],
		});
	});

	it("同一行：纵向错开不到半张卡片的算同一行，按横坐标排", () => {
		const nodes = [at("right", 500, 40), at("left", 0, 0), at("below", 0, 200)];
		expect([...arrangeNodes(nodes, "row").keys()]).toEqual(["left", "right", "below"]);
	});

	it("一个节点原地不动，没有节点时结果为空", () => {
		expect(placed(arrangeNodes([at("a", 7, 9)], "grid"))).toEqual({ a: [7, 9] });
		expect(arrangeNodes([], "row").size).toBe(0);
	});
});
