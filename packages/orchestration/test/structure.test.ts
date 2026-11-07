import { describe, expect, it } from "vitest";
import {
	chainMembers,
	checkConnection,
	type StructureDocument,
	stopCandidates,
	structureWarnings,
	subflowName,
} from "../src/index.js";

type Node = StructureDocument["nodes"][number];
type Edge = StructureDocument["edges"][number];

const entry = (id = "entry"): Node => ({ id, kind: "entry" });
const pkg = (id: string, agent?: string): Node => ({ id, kind: "package", agent });
const asyncNode = (id: string): Node => ({ id, kind: "async" });
const subflow = (id: string, name?: string): Node =>
	name === undefined ? { id, kind: "subflow_entry" } : { id, kind: "subflow_entry", name };
const stop = (id: string, target?: string): Node =>
	target === undefined
		? { id, kind: "stop_subflow" }
		: { id, kind: "stop_subflow", subflow: target };
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

	it("包节点没有 Agent，场景也没有默认 Agent", () => {
		const d = doc(
			[entry(), pkg("a"), pkg("b", "agent-b")],
			[chain("entry", "a"), chain("a", "b")],
			"",
		);
		expect(structureWarnings({ ...d, default_agent: undefined })).toEqual([
			{
				code: "missing_agent",
				node_id: "a",
				message: "节点 a 没有选择 Agent，场景也没有默认 Agent",
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

describe("子流程名称", () => {
	/** 主链依次触发若干子流程，每个子流程里放一个包节点。 */
	const withSubflows = (subflows: readonly Node[]) =>
		doc(
			[entry(), ...subflows.map((s) => asyncNode(`x_${s.id}`)), ...subflows],
			subflows.flatMap((s, i) => [
				chain(i === 0 ? "entry" : `x_${subflows[i - 1]?.id}`, `x_${s.id}`),
				dispatch(`x_${s.id}`, s.id),
			]),
		);

	it("名称唯一时没有警告", () => {
		expect(structureWarnings(withSubflows([subflow("s", "监控"), subflow("t", "压测")]))).toEqual(
			[],
		);
	});

	it("没有名称字段的旧版本以节点 ID 作为名称，不产生警告", () => {
		const d = withSubflows([subflow("s"), subflow("t", "压测")]);
		expect(structureWarnings(d)).toEqual([]);
		expect(d.nodes.filter((n) => n.kind === "subflow_entry").map(subflowName)).toEqual([
			"s",
			"压测",
		]);
	});

	it("名称为空（或只有空白）时给出警告", () => {
		expect(structureWarnings(withSubflows([subflow("s", ""), subflow("t", "  ")]))).toEqual([
			{ code: "subflow_name_empty", node_id: "s", message: "子流程入口节点 s 没有填写名称" },
			{ code: "subflow_name_empty", node_id: "t", message: "子流程入口节点 t 没有填写名称" },
		]);
	});

	it("名称重复时在每个重名的子流程入口上给出警告；以节点 ID 作为名称的旧子流程也参与比较", () => {
		expect(
			structureWarnings(
				withSubflows([subflow("s", "监控"), subflow("t", " 监控 "), subflow("u", "s")]),
			),
		).toEqual([
			{
				code: "subflow_name_duplicate",
				node_id: "s",
				message: "子流程名称「监控」重复（子流程入口节点 s、t）",
			},
			{
				code: "subflow_name_duplicate",
				node_id: "t",
				message: "子流程名称「监控」重复（子流程入口节点 s、t）",
			},
		]);
		expect(codes(withSubflows([subflow("s"), subflow("t", "s")]))).toEqual([
			["subflow_name_duplicate", "s"],
			["subflow_name_duplicate", "t"],
		]);
	});
});

describe("停止子流程节点的引用检查（SEMANTICS §4.1 第 1 条）", () => {
	/**
	 * 主链 entry → spawnA → stopper → spawnB；spawnA 触发 a（a → spawnC，触发 c），spawnB 触发 b；
	 * 另有子流程 a 上的停止子流程节点 inner。stopper 和 inner 要停止哪个子流程由参数给出。
	 */
	const scene = (target?: string, innerTarget = "c") =>
		doc(
			[
				entry(),
				asyncNode("spawnA"),
				stop("stopper", target),
				asyncNode("spawnB"),
				subflow("a", "监控"),
				asyncNode("spawnC"),
				stop("inner", innerTarget),
				subflow("b", "压测"),
				subflow("c", "日志"),
			],
			[
				chain("entry", "spawnA"),
				chain("spawnA", "stopper"),
				chain("stopper", "spawnB"),
				dispatch("spawnA", "a"),
				dispatch("spawnB", "b"),
				chain("a", "spawnC"),
				chain("spawnC", "inner"),
				dispatch("spawnC", "c"),
			],
		);

	it("候选是本链在停止子流程节点之前直接触发的子流程，以及它们间接触发的子流程", () => {
		expect(stopCandidates(scene(), "stopper")).toEqual(["a", "c"]);
		expect(stopCandidates(scene(), "inner")).toEqual(["c"]);
		// 不在任何链上的节点没有候选。
		expect(stopCandidates(doc([entry(), stop("lost")]), "lost")).toEqual([]);
	});

	it("指向合法候选时没有警告", () => {
		expect(codes(scene("a"))).toEqual([]);
		expect(codes(scene("c"))).toEqual([]);
	});

	it("没有选择子流程、或选择的子流程不存在时给出警告", () => {
		expect(structureWarnings(scene())).toEqual([
			{
				code: "stop_subflow_unset",
				node_id: "stopper",
				message: "停止子流程节点 stopper 没有选择子流程",
			},
		]);
		expect(structureWarnings(scene("gone"))).toEqual([
			{
				code: "stop_subflow_unknown",
				node_id: "stopper",
				message: "停止子流程节点 stopper 要停止的子流程 gone 不存在",
			},
		]);
		expect(codes(scene("spawnB"))).toEqual([["stop_subflow_unknown", "stopper"]]);
	});

	it("触发子流程的异步任务节点在停止子流程节点之后时给出警告", () => {
		expect(structureWarnings(scene("b"))).toEqual([
			{
				code: "stop_subflow_before_trigger",
				node_id: "stopper",
				message: "停止子流程节点 stopper 在触发子流程「压测」的异步任务节点 spawnB 之前",
			},
		]);
	});

	it("不能停止自己所在的链、上级链或其他分支上的子流程", () => {
		expect(structureWarnings(scene("a", "a"))).toEqual([
			{
				code: "stop_subflow_out_of_scope",
				node_id: "inner",
				message: "停止子流程节点 inner 只能停止本链触发的子流程，「监控」不是",
			},
		]);
		expect(codes(scene("a", "b"))).toEqual([["stop_subflow_out_of_scope", "inner"]]);
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
