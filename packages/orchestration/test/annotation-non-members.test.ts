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

/** 卡片 256×60。a(0,0) 和 c(600,0) 是成员，框是 x -24 → 880、y -20 → 80。 */
const nonMembers = (...others: Node[]) => {
	const doc: LayoutDocument = { nodes: [at("a", 0, 0), at("c", 600, 0), ...others], edges: [] };
	const [framed] = annotationBoxes({ ...doc, annotations: [annotation] });
	if (!framed) throw new Error("没有画出注释框");
	return nonMembersInside(doc, framed);
};

describe("框里的非成员节点", () => {
	it("夹在成员中间的节点算，成员自己不算", () => {
		expect(nonMembers(at("b", 300, 0))).toEqual(["b"]);
	});

	it("卡片中心在框内才算：露出框边一半以上的节点不算", () => {
		// 卡片左边在 752 时中心 x = 880，正好压在框的右边线上，算在框里；再往右一像素就不算。
		expect(nonMembers(at("edge_in", 752, 0))).toEqual(["edge_in"]);
		expect(nonMembers(at("edge_out", 753, 0))).toEqual([]);
	});

	it("框外的节点不算，没有位置的节点不算", () => {
		expect(nonMembers(at("far", 300, 400), { id: "unplaced", kind: "package" })).toEqual([]);
	});

	it("按节点在文档里的顺序给出", () => {
		expect(nonMembers(at("z", 300, 0), at("y", 100, 0))).toEqual(["z", "y"]);
	});
});
