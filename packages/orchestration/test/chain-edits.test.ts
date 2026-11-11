import { describe, expect, it } from "vitest";
import {
	type DocumentEdit,
	disconnectEdge,
	disconnectNode,
	insertAfter,
	insertOnEdge,
	insertPlacement,
	type LayoutDocument,
	nodeConnections,
	reconnectEdge,
	removeNode,
	structureWarnings,
} from "../src/index.js";

type Node = LayoutDocument["nodes"][number];
type Edge = LayoutDocument["edges"][number];

const at = (x: number, y = 0) => ({ x, y });
const entry = (x = 0, y = 0): Node => ({ id: "entry", kind: "entry", position: at(x, y) });
const pkg = (id: string, x?: number, y = 0): Node =>
	x === undefined ? { id, kind: "package" } : { id, kind: "package", position: at(x, y) };
const chain = (from: string, to: string): Edge => ({ from, to, kind: "chain" });
const dispatch = (from: string, to: string): Edge => ({ from, to, kind: "dispatch" });
const doc = (nodes: readonly Node[], edges: readonly Edge[] = []): LayoutDocument => ({
	default_agent: "agent-a",
	nodes,
	edges,
});

function done<D>(edit: DocumentEdit<D>): D {
	if (!edit.ok) throw new Error(`被拒绝：${edit.reason}`);
	return edit.doc;
}
const reasonOf = <D>(edit: DocumentEdit<D>) => (edit.ok ? null : edit.reason);
const positions = (d: LayoutDocument) =>
	Object.fromEntries(d.nodes.map((n) => [n.id, n.position?.x]));

/** entry → a → b，一行排开（列距 252）。 */
const line = doc([entry(), pkg("a", 252), pkg("b", 504)], [chain("entry", "a"), chain("a", "b")]);

describe("插入到连线上", () => {
	it("新节点接在连线两端之间，原来的连线换成两条", () => {
		const next = done(insertOnEdge(line, { from: "a", to: "b" }, pkg("x")));
		expect(next.edges).toEqual([chain("entry", "a"), chain("a", "x"), chain("x", "b")]);
		expect(next.nodes.map((n) => n.id)).toEqual(["entry", "a", "b", "x"]);
		expect(structureWarnings(next)).toEqual([]);
	});

	it("新节点放在前一个节点右侧一列，同一行后面的节点后移一列", () => {
		const next = done(insertOnEdge(line, { from: "entry", to: "a" }, pkg("x")));
		expect(positions(next)).toEqual({ entry: 0, x: 252, a: 504, b: 756 });
		expect(next.nodes.find((n) => n.id === "x")?.position).toEqual(at(252));
	});

	it("新节点自带位置时就用它，不挪动别的节点", () => {
		const next = done(insertOnEdge(line, { from: "a", to: "b" }, pkg("x", 400, 300)));
		expect(next.nodes.find((n) => n.id === "x")?.position).toEqual(at(400, 300));
		expect(positions(next)).toMatchObject({ entry: 0, a: 252, b: 504 });
	});

	it("不改动传入的文档", () => {
		const before = JSON.stringify(line);
		insertOnEdge(line, { from: "a", to: "b" }, pkg("x"));
		expect(JSON.stringify(line)).toBe(before);
	});

	it("连线不存在、是调度连线、节点 ID 重复时拒绝", () => {
		expect(reasonOf(insertOnEdge(line, { from: "entry", to: "b" }, pkg("x")))).toBe(
			"连线 entry → b 不存在",
		);
		const withSub = doc(
			[
				entry(),
				{ id: "run", kind: "async", position: at(252) },
				{ id: "sub", kind: "subflow_entry" },
			],
			[chain("entry", "run"), dispatch("run", "sub")],
		);
		expect(reasonOf(insertOnEdge(withSub, { from: "run", to: "sub" }, pkg("x")))).toBe(
			"连线 run → sub 不存在",
		);
		expect(reasonOf(insertOnEdge(line, { from: "a", to: "b" }, pkg("a")))).toBe("节点 ID a 已存在");
	});

	it("子流程入口节点不能插在链上", () => {
		expect(
			reasonOf(insertOnEdge(line, { from: "a", to: "b" }, { id: "sub", kind: "subflow_entry" })),
		).toBe("子流程入口节点只能由调度连线触发");
	});
});

describe("插入时的位置", () => {
	it("后面的位置空着时不挪动任何节点", () => {
		const spaced = doc([entry(), pkg("a", 600)], [chain("entry", "a")]);
		expect(insertPlacement(spaced, "entry")).toEqual({ position: at(252), moved: new Map() });
	});

	it("后面的节点挨得近时整体后移到刚好让出一列", () => {
		const tight = doc(
			[entry(), pkg("a", 300), pkg("b", 560)],
			[chain("entry", "a"), chain("a", "b")],
		);
		// a 压住了新位置（252）：a 移到 504，b 跟着移同样的距离。
		expect(insertPlacement(tight, "entry")).toEqual({
			position: at(252),
			moved: new Map([
				["a", at(504)],
				["b", at(764)],
			]),
		});
	});

	it("只挪同一行里排在后面的节点：别的行、前面的节点不动", () => {
		const rows = doc(
			[entry(), pkg("a", 252), pkg("b", 504), pkg("below", 252, 214), pkg("left", -300)],
			[chain("entry", "a"), chain("a", "b")],
		);
		expect([...insertPlacement(rows, "entry").moved.keys()]).toEqual(["a", "b"]);
	});

	it("来源节点没有位置时放在原点右侧一列", () => {
		expect(insertPlacement(doc([pkg("a")]), "a").position).toEqual(at(252));
	});
});

describe("在节点后面添加", () => {
	it("链尾：追加，新节点放在右侧一列，不挪动别的节点", () => {
		const withOrphan = doc([...line.nodes, pkg("orphan", 760)], line.edges);
		const next = done(insertAfter(withOrphan, "b", pkg("x")));
		expect(next.edges).toEqual([...line.edges, chain("b", "x")]);
		expect(positions(next)).toEqual({ entry: 0, a: 252, b: 504, orphan: 760, x: 756 });
	});

	it("不是链尾：插在它和下一个节点之间，后面的节点后移", () => {
		const next = done(insertAfter(line, "a", pkg("x")));
		expect(next.edges).toEqual([chain("entry", "a"), chain("a", "x"), chain("x", "b")]);
		expect(positions(next)).toEqual({ entry: 0, a: 252, x: 504, b: 756 });
	});

	it("游离节点后面也可以追加", () => {
		const next = done(insertAfter(doc([entry(), pkg("lone", 100, 400)]), "lone", pkg("x")));
		expect(next.edges).toEqual([chain("lone", "x")]);
		expect(next.nodes.find((n) => n.id === "x")?.position).toEqual(at(352, 400));
	});

	it("异步任务节点后面插入时调度连线不动", () => {
		const withSub = doc(
			[
				entry(),
				{ id: "run", kind: "async", position: at(252) },
				pkg("b", 504),
				{ id: "sub", kind: "subflow_entry", position: at(462, 256) },
			],
			[chain("entry", "run"), chain("run", "b"), dispatch("run", "sub")],
		);
		const next = done(insertAfter(withSub, "run", pkg("x")));
		expect(next.edges).toEqual([
			chain("entry", "run"),
			chain("run", "x"),
			chain("x", "b"),
			dispatch("run", "sub"),
		]);
		expect(positions(next)).toEqual({ entry: 0, run: 252, x: 504, b: 756, sub: 462 });
	});

	it("来源节点不存在、子流程入口接在链上时拒绝", () => {
		expect(reasonOf(insertAfter(line, "nope", pkg("x")))).toBe("节点 nope 不存在");
		expect(reasonOf(insertAfter(line, "b", { id: "sub", kind: "subflow_entry" }))).toBe(
			"子流程入口节点只能由调度连线触发",
		);
	});
});

describe("删除节点并接上前后", () => {
	it("链中间的节点：前后两个节点自动接上，接上的连线在原来入线的位置", () => {
		const next = done(removeNode(line, "a"));
		expect(next.nodes.map((n) => n.id)).toEqual(["entry", "b"]);
		expect(next.edges).toEqual([chain("entry", "b")]);
		expect(structureWarnings(next)).toEqual([]);
	});

	it("链尾、游离节点：只删除节点和它的连线", () => {
		expect(done(removeNode(line, "b")).edges).toEqual([chain("entry", "a")]);
		const withOrphan = doc([...line.nodes, pkg("orphan")], line.edges);
		expect(done(removeNode(withOrphan, "orphan"))).toEqual(line);
	});

	it("异步任务节点：调度连线一并删除，链照样接上", () => {
		const withSub = doc(
			[entry(), { id: "run", kind: "async" }, pkg("b"), { id: "sub", kind: "subflow_entry" }],
			[chain("entry", "run"), dispatch("run", "sub"), chain("run", "b")],
		);
		const next = done(removeNode(withSub, "run"));
		expect(next.edges).toEqual([chain("entry", "b")]);
		expect(next.nodes.map((n) => n.id)).toEqual(["entry", "b", "sub"]);
	});

	it("子流程入口节点：调度连线和出线都删除，不接上", () => {
		const withSub = doc(
			[entry(), { id: "run", kind: "async" }, { id: "sub", kind: "subflow_entry" }, pkg("s1")],
			[chain("entry", "run"), dispatch("run", "sub"), chain("sub", "s1")],
		);
		expect(done(removeNode(withSub, "sub")).edges).toEqual([chain("entry", "run")]);
	});

	it("入线或出线不止一条时不接上", () => {
		const merged = doc(
			[entry(), pkg("a"), pkg("b"), pkg("c")],
			[chain("entry", "b"), chain("a", "b"), chain("b", "c")],
		);
		expect(done(removeNode(merged, "b")).edges).toEqual([]);
	});

	it("入口节点不能删除；节点不存在时拒绝", () => {
		expect(reasonOf(removeNode(line, "entry"))).toBe("入口节点不能删除");
		expect(reasonOf(removeNode(line, "nope"))).toBe("节点 nope 不存在");
	});

	it("不改动传入的文档", () => {
		const before = JSON.stringify(line);
		removeNode(line, "a");
		expect(JSON.stringify(line)).toBe(before);
	});
});

describe("断开入线 / 出线", () => {
	const withSub = doc(
		[entry(), { id: "run", kind: "async" }, pkg("b"), { id: "sub", kind: "subflow_entry" }],
		[chain("entry", "run"), dispatch("run", "sub"), chain("run", "b")],
	);

	it("节点的入线：连到它的连线（子流程入口是调度连线）；出线：从它连出的链上连线", () => {
		expect(nodeConnections(withSub, "run")).toEqual({
			in: [chain("entry", "run")],
			out: [chain("run", "b")],
		});
		expect(nodeConnections(withSub, "sub")).toEqual({ in: [dispatch("run", "sub")], out: [] });
		expect(nodeConnections(withSub, "entry")).toEqual({ in: [], out: [chain("entry", "run")] });
	});

	it("断开入线只删入线，断开出线只删链上的出线（调度连线留着）", () => {
		expect(disconnectNode(withSub, "run", "in").edges).toEqual([
			dispatch("run", "sub"),
			chain("run", "b"),
		]);
		expect(disconnectNode(withSub, "run", "out").edges).toEqual([
			chain("entry", "run"),
			dispatch("run", "sub"),
		]);
		expect(disconnectNode(withSub, "sub", "in").edges).toEqual([
			chain("entry", "run"),
			chain("run", "b"),
		]);
	});

	it("没有对应连线时原样返回", () => {
		expect(disconnectNode(withSub, "b", "out")).toBe(withSub);
	});
});

describe("改接连线", () => {
	/** entry → a → b，另有游离节点 c。 */
	const withLone = doc([...line.nodes, pkg("c", 252, 214)], line.edges);

	it("改接终点：连线换到新节点上，留在原来的位置", () => {
		const next = done(reconnectEdge(withLone, chain("a", "b"), { from: "a", to: "c" }));
		expect(next.edges).toEqual([chain("entry", "a"), chain("a", "c")]);
		expect(next.nodes).toBe(withLone.nodes);
	});

	it("改接起点", () => {
		const next = done(reconnectEdge(withLone, chain("a", "b"), { from: "c", to: "b" }));
		expect(next.edges).toEqual([chain("entry", "a"), chain("c", "b")]);
	});

	it("两端都没变时原样返回", () => {
		expect(done(reconnectEdge(line, chain("a", "b"), { from: "a", to: "b" }))).toBe(line);
	});

	it("不分叉、不汇合、不成环、不连到自己、不连到入口节点：拒绝并说明原因", () => {
		expect(reasonOf(reconnectEdge(line, chain("a", "b"), { from: "entry", to: "b" }))).toBe(
			"节点 entry 已有出线，链不能分叉",
		);
		expect(reasonOf(reconnectEdge(line, chain("entry", "a"), { from: "entry", to: "b" }))).toBe(
			"节点 b 已有入线，链不能汇合",
		);
		expect(reasonOf(reconnectEdge(line, chain("a", "b"), { from: "a", to: "a" }))).toBe(
			"节点不能连到自己",
		);
		expect(reasonOf(reconnectEdge(line, chain("a", "b"), { from: "a", to: "entry" }))).toBe(
			"入口节点不能有入线",
		);
		const loop = doc([pkg("x"), pkg("y"), pkg("z")], [chain("x", "y"), chain("y", "z")]);
		expect(reasonOf(reconnectEdge(loop, chain("y", "z"), { from: "y", to: "x" }))).toBe(
			"连线会形成环",
		);
	});

	it("调度连线改接到另一个子流程入口；连到别的节点时拒绝", () => {
		const subs = doc(
			[
				entry(),
				{ id: "run", kind: "async" },
				{ id: "sub", kind: "subflow_entry" },
				{ id: "other", kind: "subflow_entry" },
				pkg("b"),
			],
			[chain("entry", "run"), dispatch("run", "sub"), chain("run", "b")],
		);
		expect(
			done(reconnectEdge(subs, dispatch("run", "sub"), { from: "run", to: "other" })).edges,
		).toEqual([chain("entry", "run"), dispatch("run", "other"), chain("run", "b")]);
		expect(reasonOf(reconnectEdge(subs, dispatch("run", "sub"), { from: "run", to: "b" }))).toBe(
			"调度连线只能连到子流程入口节点",
		);
	});

	it("连线不存在时拒绝", () => {
		expect(reasonOf(reconnectEdge(line, chain("entry", "b"), { from: "entry", to: "a" }))).toBe(
			"连线 entry → b 不存在",
		);
	});

	it("不改动传入的文档", () => {
		const before = JSON.stringify(withLone);
		reconnectEdge(withLone, chain("a", "b"), { from: "a", to: "c" });
		expect(JSON.stringify(withLone)).toBe(before);
	});
});

describe("断开连线", () => {
	it("只删这一条连线，节点不动", () => {
		const next = disconnectEdge(line, chain("a", "b"));
		expect(next.edges).toEqual([chain("entry", "a")]);
		expect(next.nodes).toBe(line.nodes);
	});

	it("连线种类也要对上；没有这条连线时原样返回", () => {
		expect(disconnectEdge(line, dispatch("a", "b"))).toBe(line);
		expect(disconnectEdge(line, chain("entry", "b"))).toBe(line);
	});
});
