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
	members: Partial<Pick<AnnotationMembers, "nodes" | "subflows" | "note">>,
	id = "annotation_1",
): AnnotationMembers => ({ id, nodes: [], subflows: [], ...members });

/**
 * 主链 entry(0,0) → fetch(300,0) → spawn(600,0)，spawn 调度子流程 sub(834,204) → spawn2(1134,204)，
 * spawn2 再调度下级子流程 deep(1368,368) → deep_ping(1668,368)。卡片 256×60。
 */
const doc: LayoutDocument = {
	nodes: [
		at("entry", "entry", 0, 0),
		at("fetch", "package", 300, 0),
		at("spawn", "async", 600, 0),
		at("sub", "subflow_entry", 834, 204),
		at("spawn2", "async", 1134, 204),
		at("deep", "subflow_entry", 1368, 368),
		at("deep_ping", "package", 1668, 368),
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
	annotationBoxes({ ...doc, annotations: [annotation(members)] }).map(
		({ annotation, ...rest }) => ({
			id: annotation.id,
			...rest,
		}),
	);

// 注释框的留白：四周 24 / 20 / 24 / 20（标题写在框外上方）；有备注时上方再留 56 + 12 放便签。子流程区域的留白：左右 24，上 44（标题行），下 20。
describe("由成员算出注释框的范围", () => {
	it("只有节点成员：成员卡片的外接框加留白", () => {
		expect(boxOf({ nodes: ["fetch", "spawn"] })).toEqual([
			{
				id: "annotation_1",
				members: ["fetch", "spawn"],
				box: { x: 300 - 24, y: -20, w: 600 + 256 - 300 + 48, h: 60 + 40 },
			},
		]);
	});

	it("节点成员不挨在一起：框住它们的外接框，中间的非成员不算成员", () => {
		const [framed] = boxOf({ nodes: ["entry", "spawn"] });
		expect(framed?.box).toEqual({ x: -24, y: -20, w: 600 + 256 + 48, h: 60 + 40 });
		expect(framed?.members).toEqual(["entry", "spawn"]);
	});

	it("只有子流程成员：它和它下级子流程的区域合起来，外面再加一圈留白", () => {
		// 子流程 sub 的区域：x 810 → 1414，y 160 → 284；下级子流程 deep 的区域：x 1344 → 1948，y 324 → 448。
		expect(boxOf({ subflows: ["sub"] })).toEqual([
			{
				id: "annotation_1",
				members: ["sub", "spawn2", "deep", "deep_ping"],
				box: { x: 810 - 24, y: 160 - 20, w: 1948 + 24 - 786, h: 448 + 20 - 140 },
			},
		]);
	});

	it("最下级的子流程成员只框它自己", () => {
		const [framed] = boxOf({ subflows: ["deep"] });
		expect(framed?.members).toEqual(["deep", "deep_ping"]);
		expect(framed?.box).toEqual({
			x: 1344 - 24,
			y: 324 - 20,
			w: 1948 - 1344 + 48,
			h: 448 - 324 + 40,
		});
	});

	it("节点成员和子流程成员混合：卡片和子流程区域合起来的外接框加留白", () => {
		// fetch 的卡片：x 300 → 556，y 0 → 60；子流程 deep 的区域：x 1344 → 1948，y 324 → 448。
		expect(boxOf({ nodes: ["fetch"], subflows: ["deep"] })).toEqual([
			{
				id: "annotation_1",
				members: ["fetch", "deep", "deep_ping"],
				box: { x: 300 - 24, y: -20, w: 1948 + 24 - 276, h: 448 + 20 + 20 },
			},
		]);
	});

	it("有备注时框的上方多留便签的位置（56 + 12）；备注只有空白时不留", () => {
		const [noted] = boxOf({ nodes: ["fetch"], note: "先拉取快照" });
		expect(noted?.box).toEqual({ x: 276, y: -20 - 68, w: 256 + 48, h: 60 + 40 + 68 });
		const [blank] = boxOf({ nodes: ["fetch"], note: "  " });
		expect(blank?.box.y).toBe(-20);
	});

	it("子流程成员的链变长，框跟着变大", () => {
		const longer: LayoutDocument = {
			nodes: [...doc.nodes, at("more", "package", 1700, 204)],
			edges: [...doc.edges, chain("spawn2", "more")],
		};
		const [box] = annotationBoxes({ ...longer, annotations: [annotation({ subflows: ["sub"] })] });
		expect((box?.box.x ?? 0) + (box?.box.w ?? 0)).toBe(1700 + 256 + 24 + 24);
		expect(box?.members).toEqual(["sub", "spawn2", "deep", "deep_ping", "more"]);
	});

	it("按 annotations 的顺序给出（后面的画在上层）", () => {
		const boxes = annotationBoxes({
			...doc,
			annotations: [annotation({ nodes: ["fetch"] }, "b"), annotation({ nodes: ["entry"] }, "a")],
		});
		expect(boxes.map((b) => b.annotation.id)).toEqual(["b", "a"]);
	});
});
