import { describe, expect, it } from "vitest";
import { annotationMembersOfSelection, type StructureDocument } from "../src/index.js";

type Node = StructureDocument["nodes"][number];
type Edge = StructureDocument["edges"][number];

const node = (id: string, kind: Node["kind"]): Node => ({ id, kind });
const chain = (from: string, to: string): Edge => ({ from, to, kind: "chain" });
const dispatch = (from: string, to: string): Edge => ({ from, to, kind: "dispatch" });

/**
 * 主链 entry → fetch → spawn → ping，spawn 调度子流程 sub（sub → a → b），
 * sub 里的 spawn2 再调度下级子流程 deep（deep → d）；另有只有入口的子流程 lone。
 */
const doc: StructureDocument = {
	nodes: [
		node("entry", "entry"),
		node("fetch", "package"),
		node("spawn", "async"),
		node("ping", "package"),
		node("sub", "subflow_entry"),
		node("a", "package"),
		node("spawn2", "async"),
		node("b", "package"),
		node("deep", "subflow_entry"),
		node("d", "package"),
		node("lone", "subflow_entry"),
	],
	edges: [
		chain("entry", "fetch"),
		chain("fetch", "spawn"),
		chain("spawn", "ping"),
		dispatch("spawn", "sub"),
		chain("sub", "a"),
		chain("a", "spawn2"),
		chain("spawn2", "b"),
		dispatch("spawn2", "deep"),
		chain("deep", "d"),
	],
};

const SUB = ["sub", "a", "spawn2", "b"];

describe("从选中的节点算出注释框的成员", () => {
	it("只选了主链上的节点：全记为节点成员", () => {
		expect(annotationMembersOfSelection(doc, ["fetch", "spawn"])).toEqual({
			nodes: ["fetch", "spawn"],
			subflows: [],
		});
	});

	it("子流程链上的节点全被选中：记为子流程成员，链上的节点不再单独记", () => {
		expect(annotationMembersOfSelection(doc, ["fetch", "spawn", ...SUB])).toEqual({
			nodes: ["fetch", "spawn"],
			subflows: ["sub"],
		});
	});

	it("只选中子流程的一部分：那部分节点按节点成员记", () => {
		expect(annotationMembersOfSelection(doc, ["fetch", "sub", "a"])).toEqual({
			nodes: ["fetch", "sub", "a"],
			subflows: [],
		});
		expect(annotationMembersOfSelection(doc, ["b"])).toEqual({ nodes: ["b"], subflows: [] });
	});

	it("混合：完整的子流程记子流程成员，另一个只选了一部分的子流程和主链上的节点按节点记", () => {
		expect(annotationMembersOfSelection(doc, ["ping", "deep", "d", "sub", "a"])).toEqual({
			nodes: ["ping", "sub", "a"],
			subflows: ["deep"],
		});
	});

	it("子流程成员连同它下级的子流程：只选上级的链就记上级，下级的子流程和节点不再单独记", () => {
		expect(annotationMembersOfSelection(doc, SUB)).toEqual({ nodes: [], subflows: ["sub"] });
		expect(annotationMembersOfSelection(doc, ["ping", ...SUB, "d"])).toEqual({
			nodes: ["ping"],
			subflows: ["sub"],
		});
		expect(annotationMembersOfSelection(doc, ["deep", "d"])).toEqual({
			nodes: [],
			subflows: ["deep"],
		});
	});

	it("子流程只有入口节点：入口被选中就是整个子流程", () => {
		expect(annotationMembersOfSelection(doc, ["lone", "fetch"])).toEqual({
			nodes: ["fetch"],
			subflows: ["lone"],
		});
	});

	it("成员按节点在文档里的顺序排列，和选中的先后无关", () => {
		expect(
			annotationMembersOfSelection(doc, ["deep", "d", "ping", "b", "spawn2", "a", "sub", "fetch"]),
		).toEqual({
			nodes: ["fetch", "ping"],
			subflows: ["sub"],
		});
	});

	it("不在文档里的节点和重复的 ID 不记", () => {
		expect(annotationMembersOfSelection(doc, ["fetch", "gone", "fetch"])).toEqual({
			nodes: ["fetch"],
			subflows: [],
		});
	});

	it("什么都没选：没有成员", () => {
		expect(annotationMembersOfSelection(doc, [])).toEqual({ nodes: [], subflows: [] });
	});
});
