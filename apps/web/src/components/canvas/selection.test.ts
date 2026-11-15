import { describe, expect, it } from "vitest";
import {
	type CanvasSelection,
	isNodeSelected,
	keepNodes,
	latestNode,
	multipleNodes,
	NO_SELECTION,
	selectNode,
	selectNodes,
	soleNode,
	toggleNode,
	withSelectChanges,
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

	it("一组节点里的 ID 不重复，空的一组就是什么都没选", () => {
		expect(selectNodes(["fetch", "report", "fetch"])).toEqual(two);
		expect(selectNodes([])).toEqual(NO_SELECTION);
	});

	it("选中多个节点时才有「已选 N 个节点」", () => {
		expect(multipleNodes(two)).toEqual(["fetch", "report"]);
		expect(multipleNodes(selectNode("fetch"))).toBeNull();
		expect(multipleNodes(annotation)).toBeNull();
		expect(multipleNodes(NO_SELECTION)).toBeNull();
	});

	it("Ctrl/⌘ + 点击：没选中的加到最后，选中的去掉，去光了就是什么都没选", () => {
		expect(toggleNode(selectNode("fetch"), "report")).toEqual(two);
		expect(toggleNode(two, "fetch")).toEqual(selectNode("report"));
		expect(toggleNode(selectNode("fetch"), "fetch")).toEqual(NO_SELECTION);
		expect(toggleNode(NO_SELECTION, "fetch")).toEqual(selectNode("fetch"));
		expect(toggleNode(annotation, "fetch")).toEqual(selectNode("fetch"));
	});

	it("框选报告的变化：新选中的排到最后，取消的去掉，已经在组里的不重复", () => {
		const changes = [
			{ id: "fetch", selected: false },
			{ id: "ping", selected: true },
			{ id: "report", selected: true },
		];
		expect(withSelectChanges(two, changes)).toEqual({ kind: "nodes", ids: ["report", "ping"] });
		expect(withSelectChanges(NO_SELECTION, [{ id: "ping", selected: true }])).toEqual(
			selectNode("ping"),
		);
		expect(
			withSelectChanges(two, [
				{ id: "fetch", selected: false },
				{ id: "report", selected: false },
			]),
		).toEqual(NO_SELECTION);
		expect(withSelectChanges(annotation, [{ id: "ping", selected: true }])).toEqual(
			selectNode("ping"),
		);
	});

	it("多选收成单选时留下最近选中的节点；其余原样", () => {
		expect(latestNode(two)).toEqual(selectNode("report"));
		const one = selectNode("fetch");
		expect(latestNode(one)).toBe(one);
		expect(latestNode(annotation)).toBe(annotation);
		expect(latestNode(NO_SELECTION)).toBe(NO_SELECTION);
	});
});
