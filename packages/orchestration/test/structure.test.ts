import { describe, expect, it } from "vitest";
import {
	chainMembers,
	checkConnection,
	type StructureDocument,
	structureWarnings,
} from "../src/index.js";

type Node = StructureDocument["nodes"][number];
type Edge = StructureDocument["edges"][number];

const entry = (id = "entry"): Node => ({ id, kind: "entry" });
const pkg = (id: string, agent?: string): Node => ({ id, kind: "package", agent });
const asyncNode = (id: string): Node => ({ id, kind: "async" });
const subflow = (id: string): Node => ({ id, kind: "subflow_entry" });
const chain = (from: string, to: string): Edge => ({ from, to, kind: "chain" });
const dispatch = (from: string, to: string): Edge => ({ from, to, kind: "dispatch" });

const doc = (
	nodes: readonly Node[],
	edges: readonly Edge[] = [],
	default_agent = "agent-a",
): StructureDocument => ({
	default_agent,
	nodes,
	edges,
});

const codes = (d: StructureDocument) => structureWarnings(d).map((w) => [w.code, w.node_id]);

describe("连线规则：单入单出", () => {
	const base = doc([entry(), pkg("a"), pkg("b"), pkg("c")], [chain("entry", "a")]);

	it("允许把链的末尾连到一个没有入线的节点", () => {
		expect(checkConnection(base, chain("a", "b"))).toBeNull();
	});

	it("节点已有出线时不能再连出（不分叉）", () => {
		expect(checkConnection(base, chain("entry", "b"))).toBe("节点 entry 已有出线，链不能分叉");
	});

	it("节点已有入线时不能再连入（不汇合）", () => {
		const d = doc([entry(), pkg("a"), pkg("b")], [chain("entry", "a")]);
		expect(checkConnection(d, chain("b", "a"))).toBe("节点 a 已有入线，链不能汇合");
	});

	it("不能连到入口节点或子流程入口节点", () => {
		const d = doc([entry(), pkg("a"), subflow("s")]);
		expect(checkConnection(d, chain("a", "entry"))).toBe("入口节点不能有入线");
		expect(checkConnection(d, chain("a", "s"))).toBe("子流程入口节点只能由调度连线触发");
	});

	it("不能连到自己，也不能成环", () => {
		const d = doc([entry(), pkg("a"), pkg("b")], [chain("a", "b")]);
		expect(checkConnection(d, chain("a", "a"))).toBe("节点不能连到自己");
		expect(checkConnection(d, chain("b", "a"))).toBe("连线会形成环");
	});

	it("连线两端必须是已存在的节点", () => {
		expect(checkConnection(base, chain("a", "zzz"))).toBe("节点 zzz 不存在");
	});

	it("调度连线只能从异步任务节点连到子流程入口节点，各自恰好一条", () => {
		const d = doc([entry(), asyncNode("x"), subflow("s"), subflow("t"), pkg("p")]);
		expect(checkConnection(d, dispatch("x", "s"))).toBeNull();
		expect(checkConnection(d, dispatch("p", "s"))).toBe("调度连线只能从异步任务节点连出");
		expect(checkConnection(d, dispatch("x", "p"))).toBe("调度连线只能连到子流程入口节点");

		const linked = doc(d.nodes, [dispatch("x", "s")]);
		expect(checkConnection(linked, dispatch("x", "t"))).toBe("异步任务节点 x 已有调度连线");
		const other = doc([...d.nodes, asyncNode("y")], [dispatch("x", "s")]);
		expect(checkConnection(other, dispatch("y", "s"))).toBe(
			"子流程入口节点 s 已被异步任务节点 x 触发",
		);
	});
});

describe("结构警告", () => {
	it("一条完整的主链没有警告", () => {
		expect(
			structureWarnings(doc([entry(), pkg("a"), pkg("b")], [chain("entry", "a"), chain("a", "b")])),
		).toEqual([]);
	});

	it("没有入口节点或有多个入口节点", () => {
		expect(codes(doc([pkg("a")]))).toEqual([
			["entry_count", undefined],
			["orphan_node", "a"],
		]);
		expect(codes(doc([entry("e1"), entry("e2")]))).toEqual([["entry_count", undefined]]);
	});

	it("没连到任何链上的节点是孤立节点", () => {
		const warnings = structureWarnings(doc([entry(), pkg("a"), pkg("b")], [chain("entry", "a")]));
		expect(warnings).toEqual([
			{ code: "orphan_node", node_id: "b", message: "节点 b 不在任何链上" },
		]);
	});

	it("分叉、汇合和环", () => {
		expect(
			codes(
				doc(
					[entry(), pkg("a"), pkg("b"), pkg("c")],
					[chain("entry", "a"), chain("entry", "b"), chain("a", "c"), chain("b", "c")],
				),
			),
		).toEqual([
			["multiple_outgoing", "entry"],
			["multiple_incoming", "c"],
		]);
		expect(codes(doc([entry(), pkg("a"), pkg("b")], [chain("a", "b"), chain("b", "a")]))).toEqual([
			["cycle", "a"],
			["orphan_node", "a"],
			["orphan_node", "b"],
		]);
	});

	it("入口节点有入线、连线指向不存在的节点", () => {
		expect(
			codes(doc([entry(), pkg("a")], [chain("entry", "a"), chain("a", "entry"), chain("a", "x")])),
		).toEqual([
			["unknown_node", "x"],
			["entry_incoming", "entry"],
			["cycle", "entry"],
		]);
	});

	it("包节点没有 Agent，编排也没有默认 Agent", () => {
		const d = doc(
			[entry(), pkg("a"), pkg("b", "agent-b")],
			[chain("entry", "a"), chain("a", "b")],
			"",
		);
		expect(structureWarnings({ ...d, default_agent: undefined })).toEqual([
			{
				code: "missing_agent",
				node_id: "a",
				message: "节点 a 没有选择 Agent，编排也没有默认 Agent",
			},
		]);
	});

	it("异步任务节点必须恰好连一个子流程入口节点；子流程入口必须恰好被一个异步任务节点触发", () => {
		expect(
			codes(
				doc(
					[entry(), asyncNode("x"), subflow("s"), pkg("p")],
					[chain("entry", "x"), chain("s", "p")],
				),
			),
		).toEqual([
			["async_without_dispatch", "x"],
			["subflow_not_triggered", "s"],
		]);
		expect(
			codes(
				doc(
					[entry(), asyncNode("x"), asyncNode("y"), subflow("s"), subflow("t")],
					[
						chain("entry", "x"),
						chain("x", "y"),
						dispatch("x", "s"),
						dispatch("x", "t"),
						dispatch("y", "s"),
						dispatch("entry", "t"),
					],
				),
			),
		).toEqual([
			["invalid_dispatch", "entry"],
			["async_multiple_dispatch", "x"],
			["subflow_multiple_triggers", "s"],
		]);
		expect(
			structureWarnings(
				doc(
					[entry(), asyncNode("x"), subflow("s"), pkg("p")],
					[chain("entry", "x"), dispatch("x", "s"), chain("s", "p")],
				),
			),
		).toEqual([]);
	});

	it("子流程嵌套最多 3 层", () => {
		const nodes: Node[] = [entry()];
		const edges: Edge[] = [];
		let start = "entry";
		for (let depth = 1; depth <= 4; depth++) {
			nodes.push(asyncNode(`x${depth}`), subflow(`s${depth}`));
			edges.push(chain(start, `x${depth}`), dispatch(`x${depth}`, `s${depth}`));
			start = `s${depth}`;
		}
		expect(codes(doc(nodes, edges))).toEqual([["nesting_too_deep", "s4"]]);
	});
});

describe("链的成员", () => {
	it("主链和每个子流程各自列出从起点沿链走到的节点，调度连线不算链", () => {
		const doc: StructureDocument = {
			nodes: [
				{ id: "e", kind: "entry" },
				{ id: "a", kind: "async" },
				{ id: "b", kind: "package" },
				{ id: "s", kind: "subflow_entry" },
				{ id: "c", kind: "package" },
				{ id: "lost", kind: "package" },
			],
			edges: [
				{ from: "e", to: "a", kind: "chain" },
				{ from: "a", to: "b", kind: "chain" },
				{ from: "a", to: "s", kind: "dispatch" },
				{ from: "s", to: "c", kind: "chain" },
			],
		};
		expect([...chainMembers(doc)]).toEqual([
			["e", ["e", "a", "b"]],
			["s", ["s", "c"]],
		]);
	});
});
