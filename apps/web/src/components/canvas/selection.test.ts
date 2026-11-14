import { describe, expect, it } from "vitest";
import {
	type CanvasSelection,
	isNodeSelected,
	keepNodes,
	NO_SELECTION,
	selectNode,
	soleNode,
} from "./selection";

const two: CanvasSelection = { kind: "nodes", ids: ["fetch", "report"] };
const annotation: CanvasSelection = { kind: "annotation", id: "annotation_1" };

describe("画布的选中状态", () => {
	it("恰好选中一个节点时才有检查器、复制和方向键作用的那个节点", () => {
		expect(soleNode(selectNode("fetch"))).toBe("fetch");
		expect(soleNode(two)).toBeNull();
		expect(soleNode(annotation)).toBeNull();
		expect(soleNode(NO_SELECTION)).toBeNull();
	});

	it("一组节点里的每个都算选中；选中注释框时没有节点选中", () => {
		expect(isNodeSelected(two, "fetch")).toBe(true);
		expect(isNodeSelected(two, "report")).toBe(true);
		expect(isNodeSelected(two, "entry")).toBe(false);
		expect(isNodeSelected(annotation, "annotation_1")).toBe(false);
		expect(isNodeSelected(NO_SELECTION, "fetch")).toBe(false);
	});

	it("删掉的、画布上没有的节点不再算选中，一个都不剩时什么都没选", () => {
		expect(keepNodes(two, (id) => id !== "fetch")).toEqual(selectNode("report"));
		expect(keepNodes(selectNode("fetch"), (id) => id !== "fetch")).toEqual(NO_SELECTION);
	});

	it("节点都还在时选中状态不变（同一个对象，画布不必重画节点）", () => {
		expect(keepNodes(two, () => true)).toBe(two);
	});

	it("只筛节点：选中的注释框和什么都没选保持原样", () => {
		expect(keepNodes(annotation, () => false)).toBe(annotation);
		expect(keepNodes(NO_SELECTION, () => false)).toBe(NO_SELECTION);
	});
});
