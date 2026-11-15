import { describe, expect, it } from "vitest";
import {
	type AnnotationMembers,
	annotationBoxes,
	type LayoutDocument,
	nonMembersInside,
} from "../src/index.js";

type Node = LayoutDocument["nodes"][number];

const at = (id: string, x: number, y: number): Node => ({
	id,
	kind: "package",
	position: { x, y },
});
const annotation: AnnotationMembers = { id: "annotation_1", nodes: ["a", "c"], subflows: [] };

/** 卡片 208×112。a(0,0) 和 c(504,0) 是成员，框是 x -24 → 736、y -44 → 132。 */
const nonMembers = (...others: Node[]) => {
	const doc: LayoutDocument = { nodes: [at("a", 0, 0), at("c", 504, 0), ...others], edges: [] };
	const [framed] = annotationBoxes({ ...doc, annotations: [annotation] });
	if (!framed) throw new Error("没有画出注释框");
	return nonMembersInside(doc, framed);
};

describe("框里的非成员节点", () => {
	it("夹在成员中间的节点算，成员自己不算", () => {
		expect(nonMembers(at("b", 252, 0))).toEqual(["b"]);
	});

	it("卡片中心在框内才算：露出框边一半以上的节点不算", () => {
		// 卡片左边在 632 时中心 x = 736，正好压在框的右边线上，算在框里；再往右一像素就不算。
		expect(nonMembers(at("edge_in", 632, 0))).toEqual(["edge_in"]);
		expect(nonMembers(at("edge_out", 633, 0))).toEqual([]);
	});

	it("框外的节点不算，没有位置的节点不算", () => {
		expect(nonMembers(at("far", 252, 400), { id: "unplaced", kind: "package" })).toEqual([]);
	});

	it("按节点在文档里的顺序给出", () => {
		expect(nonMembers(at("z", 300, 0), at("y", 100, 0))).toEqual(["z", "y"]);
	});
});
