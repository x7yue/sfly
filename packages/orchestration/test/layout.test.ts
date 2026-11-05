import { describe, expect, it } from "vitest";
import {
	ensureLayout,
	type LayoutDocument,
	NODE_SIZE,
	REGION_PADDING,
	type StructureDocument,
	tidyLayout,
} from "../src/index.js";

type Node = StructureDocument["nodes"][number];
type Edge = StructureDocument["edges"][number];

const node = (id: string, kind: Node["kind"] = "package"): Node => ({ id, kind });
const chain = (from: string, to: string): Edge => ({ from, to, kind: "chain" });
const dispatch = (from: string, to: string): Edge => ({ from, to, kind: "dispatch" });

/** 入口节点 + n-1 个包节点连成的主链。 */
function mainChain(n: number): { nodes: Node[]; edges: Edge[] } {
	const ids = ["entry", ...Array.from({ length: n - 1 }, (_, i) => `n${i + 1}`)];
	return {
		nodes: ids.map((id, i) => node(id, i === 0 ? "entry" : "package")),
		edges: ids.slice(1).map((id, i) => chain(ids[i] as string, id)),
	};
}

const at = (layout: Map<string, { x: number; y: number }>, id: string) => layout.get(id);

describe("整理布局：主链", () => {
	it("只有入口节点时放在原点", () => {
		expect(tidyLayout({ nodes: [node("entry", "entry")], edges: [] })).toEqual(
			new Map([["entry", { x: 0, y: 0 }]]),
		);
	});

	it("不超过 5 个节点的主链排成一行，节点间距 252（卡片宽 208 + 间隔 44）", () => {
		const layout = tidyLayout(mainChain(4));
		expect([...layout.values()]).toEqual([
			{ x: 0, y: 0 },
			{ x: 252, y: 0 },
			{ x: 504, y: 0 },
			{ x: 756, y: 0 },
		]);
	});

	it("更长的主链按两行折返：前一半在第一行，后一半从左侧开始排在第二行（行距 214）", () => {
		const layout = tidyLayout(mainChain(10));
		expect(at(layout, "n4")).toEqual({ x: 1008, y: 0 });
		expect(at(layout, "n5")).toEqual({ x: 0, y: 214 });
		expect(at(layout, "n9")).toEqual({ x: 1008, y: 214 });
	});

	it("奇数个节点时第一行多一个", () => {
		const layout = tidyLayout(mainChain(7));
		expect(at(layout, "n3")).toEqual({ x: 756, y: 0 });
		expect(at(layout, "n4")).toEqual({ x: 0, y: 214 });
		expect(at(layout, "n6")).toEqual({ x: 504, y: 214 });
	});

	it("按连线顺序排，不按节点在文档中的顺序", () => {
		const layout = tidyLayout({
			nodes: [node("b"), node("entry", "entry"), node("a")],
			edges: [chain("entry", "a"), chain("a", "b")],
		});
		expect(at(layout, "entry")).toEqual({ x: 0, y: 0 });
		expect(at(layout, "a")).toEqual({ x: 252, y: 0 });
		expect(at(layout, "b")).toEqual({ x: 504, y: 0 });
	});
});

describe("整理布局：子流程放在主链下方", () => {
	// entry → fetch → go(异步) → tail；go 调度 sub → sub_a；sub_a 之后 sub_go(异步) 调度 deep → deep_a。
	const doc: StructureDocument = {
		nodes: [
			node("entry", "entry"),
			node("fetch"),
			node("go", "async"),
			node("tail"),
			node("sub", "subflow_entry"),
			node("sub_a"),
			node("sub_go", "async"),
			node("deep", "subflow_entry"),
			node("deep_a"),
		],
		edges: [
			chain("entry", "fetch"),
			chain("fetch", "go"),
			chain("go", "tail"),
			dispatch("go", "sub"),
			chain("sub", "sub_a"),
			chain("sub_a", "sub_go"),
			dispatch("sub_go", "deep"),
			chain("deep", "deep_a"),
		],
	};

	it("子流程排成一行，从触发它的异步任务节点右下方开始（调度连线先落下再水平进入）", () => {
		const layout = tidyLayout(doc);
		// 主链一行，底边 112；子流程第一行 y = 112 + 144。
		expect(at(layout, "go")).toEqual({ x: 504, y: 0 });
		expect(at(layout, "sub")).toEqual({ x: 714, y: 256 });
		expect(at(layout, "sub_a")).toEqual({ x: 966, y: 256 });
		expect(at(layout, "sub_go")).toEqual({ x: 1218, y: 256 });
	});

	it("嵌套的子流程紧跟在上一层子流程下面一行（行距 216）", () => {
		const layout = tidyLayout(doc);
		expect(at(layout, "deep")).toEqual({ x: 1428, y: 472 });
		expect(at(layout, "deep_a")).toEqual({ x: 1680, y: 472 });
	});

	it("子流程区域之间、子流程区域与主链之间不重叠", () => {
		const layout = tidyLayout(doc);
		const box = (ids: string[], padded: boolean) => {
			const ps = ids.map((id) => at(layout, id) as { x: number; y: number });
			const pad = padded ? REGION_PADDING : { left: 0, top: 0, right: 0, bottom: 0 };
			return {
				top: Math.min(...ps.map((p) => p.y)) - pad.top,
				bottom: Math.max(...ps.map((p) => p.y)) + NODE_SIZE.height + pad.bottom,
			};
		};
		const main = box(["entry", "fetch", "go", "tail"], false);
		const sub = box(["sub", "sub_a", "sub_go"], true);
		const deep = box(["deep", "deep_a"], true);
		expect(sub.top).toBeGreaterThan(main.bottom);
		expect(deep.top).toBeGreaterThan(sub.bottom);
	});

	it("没有被触发的子流程和不在任何链上的节点排在最下面，从左侧开始", () => {
		const layout = tidyLayout({
			nodes: [...doc.nodes, node("lonely", "subflow_entry"), node("lonely_a"), node("orphan")],
			edges: [...doc.edges, chain("lonely", "lonely_a")],
		});
		expect(at(layout, "lonely")).toEqual({ x: 0, y: 688 });
		expect(at(layout, "lonely_a")).toEqual({ x: 252, y: 688 });
		expect(at(layout, "orphan")).toEqual({ x: 0, y: 904 });
	});

	it("链上有环时每个节点仍只出现一次", () => {
		const layout = tidyLayout({
			nodes: [node("entry", "entry"), node("a"), node("b")],
			edges: [chain("entry", "a"), chain("a", "b"), chain("b", "a")],
		});
		expect(layout.size).toBe(3);
		expect(at(layout, "b")).toEqual({ x: 504, y: 0 });
	});
});

describe("缺少布局的文档", () => {
	const positioned: LayoutDocument = {
		nodes: [
			{ id: "entry", kind: "entry", position: { x: 40, y: 40 } },
			{ id: "a", kind: "package", position: { x: 300, y: 90 } },
		],
		edges: [chain("entry", "a")],
	};

	it("所有节点都有位置时原样返回", () => {
		expect(ensureLayout(positioned)).toBe(positioned);
	});

	it("有节点缺少位置时整份文档按整理布局重新排列", () => {
		const doc: LayoutDocument = {
			...positioned,
			nodes: [...positioned.nodes, { id: "b", kind: "package" }],
			edges: [...positioned.edges, chain("a", "b")],
		};
		expect(ensureLayout(doc).nodes.map((n) => [n.id, n.position])).toEqual([
			["entry", { x: 0, y: 0 }],
			["a", { x: 252, y: 0 }],
			["b", { x: 504, y: 0 }],
		]);
	});
});
