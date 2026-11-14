import { describe, expect, it } from "vitest";
import { type AnnotationMembers, annotationBoxes, type LayoutDocument } from "../src/index.js";

type Node = LayoutDocument["nodes"][number];
type Edge = LayoutDocument["edges"][number];

const at = (id: string, kind: Node["kind"], x: number, y: number): Node => ({
	id,
	kind,
	position: { x, y },
});
const chain = (from: string, to: string): Edge => ({ from, to, kind: "chain" });
const dispatch = (from: string, to: string): Edge => ({ from, to, kind: "dispatch" });
const annotation = (
	members: Partial<Pick<AnnotationMembers, "nodes" | "subflows">>,
	id = "annotation_1",
): AnnotationMembers => ({ id, nodes: [], subflows: [], ...members });

/**
 * 主链 entry(0,0) → fetch(252,0) → spawn(504,0)，spawn 调度子流程 sub(660,230) → spawn2(912,230)，
 * spawn2 再调度下级子流程 deep(1068,460) → deep_ping(1320,460)。卡片 208×112。
 */
const doc: LayoutDocument = {
	nodes: [
		at("entry", "entry", 0, 0),
		at("fetch", "package", 252, 0),
		at("spawn", "async", 504, 0),
		at("sub", "subflow_entry", 660, 230),
		at("spawn2", "async", 912, 230),
		at("deep", "subflow_entry", 1068, 460),
		at("deep_ping", "package", 1320, 460),
	],
	edges: [
		chain("entry", "fetch"),
		chain("fetch", "spawn"),
		dispatch("spawn", "sub"),
		chain("sub", "spawn2"),
		dispatch("spawn2", "deep"),
		chain("deep", "deep_ping"),
	],
};

const boxOf = (members: Parameters<typeof annotation>[0]) =>
	annotationBoxes({ ...doc, annotations: [annotation(members)] });

// 留白：左右 24，上 44（标题行），下 20。
describe("由成员算出注释框的范围", () => {
	it("只有节点成员：成员卡片的外接框加留白", () => {
		expect(boxOf({ nodes: ["fetch", "spawn"] })).toEqual([
			{
				id: "annotation_1",
				members: ["fetch", "spawn"],
				box: { x: 252 - 24, y: -44, w: 504 + 208 - 252 + 48, h: 112 + 64 },
			},
		]);
	});

	it("节点成员不挨在一起：框住它们的外接框，中间的非成员不算成员", () => {
		const [framed] = boxOf({ nodes: ["entry", "spawn"] });
		expect(framed?.box).toEqual({ x: -24, y: -44, w: 504 + 208 + 48, h: 112 + 64 });
		expect(framed?.members).toEqual(["entry", "spawn"]);
	});

	it("只有子流程成员：子流程区域外面再加一圈留白，不含它下级的子流程", () => {
		// 子流程 sub 的区域：sub、spawn2 两张卡片加留白，即 x 636 → 1144，y 186 → 362。
		const region = { x: 660 - 24, y: 230 - 44, w: 912 + 208 - 660 + 48, h: 112 + 64 };
		expect(boxOf({ subflows: ["sub"] })).toEqual([
			{
				id: "annotation_1",
				members: ["sub", "spawn2"],
				box: {
					x: region.x - 24,
					y: region.y - 44,
					w: region.w + 48,
					h: region.h + 64,
				},
			},
		]);
	});

	it("节点成员和子流程成员混合：卡片和子流程区域合起来的外接框加留白", () => {
		// fetch 的卡片：x 252 → 460，y 0 → 112；子流程 deep 的区域：x 1044 → 1552，y 416 → 592。
		expect(boxOf({ nodes: ["fetch"], subflows: ["deep"] })).toEqual([
			{
				id: "annotation_1",
				members: ["fetch", "deep", "deep_ping"],
				box: { x: 252 - 24, y: -44, w: 1552 + 24 - 228, h: 592 + 20 + 44 },
			},
		]);
	});

	it("子流程成员的链变长，框跟着变大", () => {
		const longer: LayoutDocument = {
			nodes: [...doc.nodes, at("more", "package", 1164, 230)],
			edges: [...doc.edges, chain("spawn2", "more")],
		};
		const [box] = annotationBoxes({ ...longer, annotations: [annotation({ subflows: ["sub"] })] });
		expect(box?.box.w).toBe(1164 + 208 - 660 + 48 + 48);
		expect(box?.members).toEqual(["sub", "spawn2", "more"]);
	});

	it("按 annotations 的顺序给出（后面的画在上层）", () => {
		const boxes = annotationBoxes({
			...doc,
			annotations: [annotation({ nodes: ["fetch"] }, "b"), annotation({ nodes: ["entry"] }, "a")],
		});
		expect(boxes.map((b) => b.id)).toEqual(["b", "a"]);
	});
});
