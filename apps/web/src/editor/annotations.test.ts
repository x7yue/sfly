import type { Annotation } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { applyAnnotationDrop } from "./annotations";

// 拖动节点松手后改注释框：按住 Alt 拖出的框里移出，拖进的框里加入（和这次拖动算一步撤销，见 ScenarioEditor）。

const annotations: Annotation[] = [
	{ id: "prep", title: "准备", nodes: ["a", "b"], subflows: [] },
	{ id: "tail", title: "收尾", nodes: ["c"], subflows: ["report"] },
	{ id: "solo", title: "单独", nodes: ["d"], subflows: [] },
];
const none = { nodes: [], subflows: [] };

describe("applyAnnotationDrop", () => {
	it("加入：成员接在后面，已经是成员的不重复记，子流程成员一起并进去", () => {
		const next = applyAnnotationDrop(
			annotations,
			{ dragged: ["b", "x", "sub"], join: { id: "tail", title: "收尾", nodes: ["x"] }, leave: [] },
			{ nodes: ["x", "c"], subflows: ["sub", "report"] },
		);
		expect(next[1]).toEqual({
			id: "tail",
			title: "收尾",
			nodes: ["c", "x"],
			subflows: ["report", "sub"],
		});
		expect(next[0]).toBe(annotations[0]);
	});

	it("拖出：从框里移出拖动的节点；移出后没有成员的框一起删除", () => {
		const next = applyAnnotationDrop(
			annotations,
			{
				dragged: ["a", "d"],
				join: null,
				leave: [
					{ id: "prep", title: "准备", emptied: false },
					{ id: "solo", title: "单独", emptied: true },
				],
			},
			none,
		);
		expect(next).toEqual([
			{ id: "prep", title: "准备", nodes: ["b"], subflows: [] },
			annotations[1],
		]);
	});

	it("拖出一个框、加入另一个框，一次改完", () => {
		const next = applyAnnotationDrop(
			annotations,
			{
				dragged: ["a"],
				join: { id: "tail", title: "收尾", nodes: ["a"] },
				leave: [{ id: "prep", title: "准备", emptied: false }],
			},
			{ nodes: ["a"], subflows: [] },
		);
		expect(next.map((a) => a.nodes)).toEqual([["b"], ["c", "a"], ["d"]]);
	});

	it("没有要改的：返回原来的数组", () => {
		expect(applyAnnotationDrop(annotations, { dragged: ["a"], join: null, leave: [] }, none)).toBe(
			annotations,
		);
	});
});
