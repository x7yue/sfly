import { describe, expect, it } from "vitest";
import { type LayoutDocument, removeNodes, structureWarnings } from "../src/index.js";

type Node = LayoutDocument["nodes"][number];
type Edge = LayoutDocument["edges"][number];

const entry: Node = { id: "entry", kind: "entry" };
const pkg = (id: string): Node => ({ id, kind: "package" });
const chain = (from: string, to: string): Edge => ({ from, to, kind: "chain" });
const dispatch = (from: string, to: string): Edge => ({ from, to, kind: "dispatch" });
const doc = (nodes: readonly Node[], edges: readonly Edge[]): LayoutDocument => ({
	default_agent: "agent-a",
	nodes,
	edges,
});

function done(edit: ReturnType<typeof removeNodes<LayoutDocument>>) {
	if (!edit.ok) throw new Error(`被拒绝：${edit.reason}`);
	return edit;
}
const idsOf = (d: LayoutDocument) => d.nodes.map((n) => n.id);

/** entry → a → b → c */
const line = doc(
	[entry, pkg("a"), pkg("b"), pkg("c")],
	[chain("entry", "a"), chain("a", "b"), chain("b", "c")],
);

describe("删除一组节点（画布多选后删除）", () => {
	it("链上连续的几个节点：逐个按单个删除的规则接上前后，最后前后两端接上", () => {
		const edit = done(removeNodes(line, ["a", "b"]));
		expect(idsOf(edit.doc)).toEqual(["entry", "c"]);
		expect(edit.doc.edges).toEqual([chain("entry", "c")]);
		expect(edit.removed).toEqual(["a", "b"]);
		expect(edit.skipped).toEqual([]);
		expect(structureWarnings(edit.doc)).toEqual([]);
	});

	it("入口节点跳过并写明原因，其余照删", () => {
		const edit = done(removeNodes(line, ["entry", "b"]));
		expect(idsOf(edit.doc)).toEqual(["entry", "a", "c"]);
		expect(edit.doc.edges).toEqual([chain("entry", "a"), chain("a", "c")]);
		expect(edit.removed).toEqual(["b"]);
		expect(edit.skipped).toEqual([{ id: "entry", reason: "入口节点不能删除" }]);
	});

	it("一个都删不了时拒绝，原因与单个删除相同", () => {
		expect(removeNodes(line, ["entry"])).toEqual({ ok: false, reason: "入口节点不能删除" });
	});

	it("按节点在文档里的顺序删除，结果与选中的先后无关", () => {
		// b 有两条入线：先删 b 时不接上；先删 a 后 b 只剩一条入线，删 b 时接上 entry → c。
		const merged = doc(
			[entry, pkg("a"), pkg("b"), pkg("c")],
			[chain("entry", "b"), chain("a", "b"), chain("b", "c")],
		);
		for (const order of [
			["a", "b"],
			["b", "a"],
		]) {
			const edit = done(removeNodes(merged, order));
			expect(edit.doc.edges, order.join(",")).toEqual([chain("entry", "c")]);
			expect(edit.removed, order.join(",")).toEqual(["a", "b"]);
		}
	});

	it("整个子流程：入口和链上的节点、触发它的调度连线一起删除，主链不变", () => {
		const withSub = doc(
			[entry, { id: "run", kind: "async" }, { id: "sub", kind: "subflow_entry" }, pkg("s1")],
			[chain("entry", "run"), dispatch("run", "sub"), chain("sub", "s1")],
		);
		const edit = done(removeNodes(withSub, ["s1", "sub"]));
		expect(idsOf(edit.doc)).toEqual(["entry", "run"]);
		expect(edit.doc.edges).toEqual([chain("entry", "run")]);
	});

	it("不改动传入的文档", () => {
		const before = JSON.stringify(line);
		removeNodes(line, ["a", "b", "entry"]);
		expect(JSON.stringify(line)).toBe(before);
	});
});
