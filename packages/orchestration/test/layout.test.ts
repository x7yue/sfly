import { describe, expect, it } from "vitest";
import {
	ANNOTATION_TITLE_SPACE,
	type AnnotatedDocument,
	type AnnotationMembers,
	annotationBoxes,
	ensureLayout,
	fillMissingPositions,
	freeCardAt,
	freePosition,
	type LayoutDocument,
	NODE_SIZE,
	nonMembersInside,
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

	it("不超过 5 个节点的主链排成一行，节点间距 300（卡片宽 256 + 间隔 44）", () => {
		const layout = tidyLayout(mainChain(4));
		expect([...layout.values()]).toEqual([
			{ x: 0, y: 0 },
			{ x: 300, y: 0 },
			{ x: 600, y: 0 },
			{ x: 900, y: 0 },
		]);
	});

	it("更长的主链折成几行，每行从左侧开始（行距 162）：每行不超过 5 个，行数最少、各行尽量一样多", () => {
		const layout = tidyLayout(mainChain(10));
		expect(at(layout, "n4")).toEqual({ x: 1200, y: 0 });
		expect(at(layout, "n5")).toEqual({ x: 0, y: 162 });
		expect(at(layout, "n9")).toEqual({ x: 1200, y: 162 });
	});

	it("分不平均时前面的行多一个", () => {
		const layout = tidyLayout(mainChain(7));
		expect(at(layout, "n3")).toEqual({ x: 900, y: 0 });
		expect(at(layout, "n4")).toEqual({ x: 0, y: 162 });
		expect(at(layout, "n6")).toEqual({ x: 600, y: 162 });
	});

	it("超过 10 个节点时折成三行以上，每行仍不超过 5 个", () => {
		const layout = tidyLayout(mainChain(11));
		expect(at(layout, "n3")).toEqual({ x: 900, y: 0 });
		expect(at(layout, "n4")).toEqual({ x: 0, y: 162 });
		expect(at(layout, "n8")).toEqual({ x: 0, y: 324 });
		expect(at(layout, "n10")).toEqual({ x: 600, y: 324 });
	});

	it("按连线顺序排，不按节点在文档中的顺序", () => {
		const layout = tidyLayout({
			nodes: [node("b"), node("entry", "entry"), node("a")],
			edges: [chain("entry", "a"), chain("a", "b")],
		});
		expect(at(layout, "entry")).toEqual({ x: 0, y: 0 });
		expect(at(layout, "a")).toEqual({ x: 300, y: 0 });
		expect(at(layout, "b")).toEqual({ x: 600, y: 0 });
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
		// 主链一行，底边 60；子流程第一行 y = 60 + 166。
		expect(at(layout, "go")).toEqual({ x: 600, y: 0 });
		expect(at(layout, "sub")).toEqual({ x: 834, y: 226 });
		expect(at(layout, "sub_a")).toEqual({ x: 1134, y: 226 });
		expect(at(layout, "sub_go")).toEqual({ x: 1434, y: 226 });
	});

	it("嵌套的子流程紧跟在上一层子流程下面一行（行距 186）", () => {
		const layout = tidyLayout(doc);
		expect(at(layout, "deep")).toEqual({ x: 1668, y: 412 });
		expect(at(layout, "deep_a")).toEqual({ x: 1968, y: 412 });
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
		expect(at(layout, "lonely")).toEqual({ x: 0, y: 598 });
		expect(at(layout, "lonely_a")).toEqual({ x: 300, y: 598 });
		expect(at(layout, "orphan")).toEqual({ x: 0, y: 784 });
	});

	it("链上有环时每个节点仍只出现一次", () => {
		const layout = tidyLayout({
			nodes: [node("entry", "entry"), node("a"), node("b")],
			edges: [chain("entry", "a"), chain("a", "b"), chain("b", "a")],
		});
		expect(layout.size).toBe(3);
		expect(at(layout, "b")).toEqual({ x: 600, y: 0 });
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
			["a", { x: 300, y: 0 }],
			["b", { x: 600, y: 0 }],
		]);
	});
});

describe("补坐标", () => {
	const doc: LayoutDocument = {
		nodes: [
			{ id: "entry", kind: "entry", position: { x: 40, y: 40 } },
			{ id: "a", kind: "package", position: { x: 300, y: 300 } },
			{ id: "b", kind: "package" },
			{ id: "c", kind: "package" },
		],
		edges: [chain("entry", "a"), chain("a", "b"), chain("b", "c")],
	};

	it("没有位置的节点取整理布局的位置，已有位置的节点不动", () => {
		expect(fillMissingPositions(doc).nodes.map((n) => [n.id, n.position])).toEqual([
			["entry", { x: 40, y: 40 }],
			["a", { x: 300, y: 300 }],
			["b", { x: 600, y: 0 }],
			["c", { x: 900, y: 0 }],
		]);
	});

	it("在已有坐标的链中间插入没坐标的节点：新节点不压住任何节点，已有坐标不变", () => {
		const existing = [
			{ id: "entry", kind: "entry" as const, position: { x: 0, y: 0 } },
			{ id: "b", kind: "package" as const, position: { x: 300, y: 0 } },
			{ id: "c", kind: "package" as const, position: { x: 600, y: 0 } },
		];
		const inserted: LayoutDocument = {
			nodes: [existing[0], { id: "a", kind: "package" }, existing[1], existing[2]] as Node[],
			edges: [chain("entry", "a"), chain("a", "b"), chain("b", "c")],
		};
		const filled = fillMissingPositions(inserted).nodes;
		for (const e of existing)
			expect(filled.find((n) => n.id === e.id)?.position).toEqual(e.position);
		const cards = filled.map((n) => n.position as { x: number; y: number });
		cards.forEach((p, i) => {
			cards.slice(i + 1).forEach((q) => {
				const apart =
					Math.abs(p.x - q.x) >= NODE_SIZE.width || Math.abs(p.y - q.y) >= NODE_SIZE.height;
				expect(apart).toBe(true);
			});
		});
	});

	it("连续缺坐标的几个节点互相也不重叠", () => {
		const doc: LayoutDocument = {
			nodes: [
				{ id: "entry", kind: "entry", position: { x: 0, y: 0 } },
				{ id: "a", kind: "package" },
				{ id: "b", kind: "package" },
				{ id: "c", kind: "package", position: { x: 300, y: 0 } },
				{ id: "d", kind: "package", position: { x: 600, y: 0 } },
			],
			edges: [chain("entry", "a"), chain("a", "b"), chain("b", "c"), chain("c", "d")],
		};
		const cards = fillMissingPositions(doc).nodes.map(
			(n) => n.position as { x: number; y: number },
		);
		cards.forEach((p, i) => {
			cards.slice(i + 1).forEach((q) => {
				const apart =
					Math.abs(p.x - q.x) >= NODE_SIZE.width || Math.abs(p.y - q.y) >= NODE_SIZE.height;
				expect(apart).toBe(true);
			});
		});
	});

	it("所有节点都有位置时原样返回", () => {
		const positioned: LayoutDocument = {
			...doc,
			nodes: doc.nodes.map((n) => ({ ...n, position: n.position ?? { x: 1, y: 2 } })),
		};
		expect(fillMissingPositions(positioned)).toBe(positioned);
	});
});

describe("没有来源的新节点落在哪（视口中心或右键位置）", () => {
	// 节点卡片 256 × 60。
	it("落点空着就用它", () => {
		expect(freePosition({ x: 400, y: 300 }, [{ x: 0, y: 0 }])).toEqual({ x: 400, y: 300 });
		// 贴边不算重叠。
		expect(freePosition({ x: 256, y: 0 }, [{ x: 0, y: 0 }])).toEqual({ x: 256, y: 0 });
	});

	it("与已有节点重叠时按固定步长往右下错开，直到不压住任何节点", () => {
		expect(freePosition({ x: 10, y: 10 }, [{ x: 0, y: 0 }])).toEqual({ x: 74, y: 74 });
		// 错开一次后又压住另一个节点：继续错开。
		expect(
			freePosition({ x: 0, y: 0 }, [
				{ x: 0, y: 0 },
				{ x: 100, y: 100 },
			]),
		).toEqual({ x: 160, y: 160 });
	});
});

describe("按卡片中心放置（视口中心、右键处、粘贴）", () => {
	it("卡片中心落在给定的点上，坐标取整；压住已有节点时同样错开", () => {
		expect(freeCardAt({ x: 128.4, y: 30.6 }, [])).toEqual({ x: 0, y: 1 });
		expect(freeCardAt({ x: 128, y: 30 }, [{ x: 0, y: 0 }])).toEqual({ x: 64, y: 64 });
	});
});

type Placed = Map<string, { x: number; y: number }>;
/** 带注释框的文档（整理布局读取它的成员）。 */
type TidyDocument = StructureDocument & AnnotatedDocument;

/** 整理布局的结果写回文档（画注释框、查框里的非成员要用）。 */
const laidOut = (doc: TidyDocument, layout: Placed): LayoutDocument & TidyDocument => ({
	...doc,
	nodes: doc.nodes.map((n) => ({ ...n, position: layout.get(n.id) })),
});

/** 两个矩形是否有重叠的面积（贴边不算）。 */
const overlap = (
	a: { x: number; y: number; w: number; h: number },
	b: { x: number; y: number; w: number; h: number },
) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * 调度连线经过了哪些别的卡片：连线从异步任务节点底边中点竖直落下，再水平进入子流程入口左侧中点
 * （画布 FlowEdge 的画法），两段各看成 1px 宽的矩形。返回「连线 → 卡片」。
 */
function dispatchCrossings(doc: TidyDocument, layout: Placed): string[] {
	const card = (id: string) => {
		const p = layout.get(id) as { x: number; y: number };
		return { x: p.x, y: p.y, w: NODE_SIZE.width, h: NODE_SIZE.height };
	};
	const crossed: string[] = [];
	for (const e of doc.edges) {
		if (e.kind !== "dispatch") continue;
		const from = layout.get(e.from) as { x: number; y: number };
		const to = layout.get(e.to) as { x: number; y: number };
		const x = from.x + NODE_SIZE.width / 2;
		const yEnd = to.y + NODE_SIZE.height / 2;
		const drop = { x, y: from.y + NODE_SIZE.height, w: 1, h: yEnd - from.y - NODE_SIZE.height };
		const run = { x, y: yEnd, w: to.x - x, h: 1 };
		for (const n of doc.nodes) {
			if (n.id === e.from || n.id === e.to) continue;
			if (overlap(drop, card(n.id)) || overlap(run, card(n.id)))
				crossed.push(`${e.from} → ${n.id}`);
		}
	}
	return crossed;
}

const annotation = (id: string, members: Partial<AnnotationMembers>): AnnotationMembers => ({
	id,
	nodes: [],
	subflows: [],
	...members,
});

describe("整理布局：按注释框分段", () => {
	// 全天测试的主链：entry → 升级（2 个）→ 下单（1 个）→ 运行（3 个，触发「运行期间」）→ 收盘（4 个）。
	const ids = ["entry", "u1", "u2", "o1", "r1", "r2", "r3", "c1", "c2", "c3", "c4"];
	const phases: TidyDocument = {
		nodes: ids.map((id) => node(id, id === "entry" ? "entry" : id === "r1" ? "async" : "package")),
		edges: ids.slice(1).map((id, i) => chain(ids[i] as string, id)),
		annotations: [
			annotation("upgrade", { nodes: ["u1", "u2"] }),
			annotation("order", { nodes: ["o1"] }),
			annotation("running", { nodes: ["r1", "r2", "r3"] }),
			annotation("closing", { nodes: ["c1", "c2", "c3", "c4"] }),
		],
	};

	it("同一个注释框的成员排在同一行，换行只发生在注释框之间", () => {
		const layout = tidyLayout(phases);
		const rowOf = (id: string) => at(layout, id)?.y;
		expect(["entry", "u1", "u2", "o1"].map(rowOf)).toEqual([0, 0, 0, 0]);
		// 两行之间有注释框时行距多 40。
		expect(["r1", "r2", "r3"].map(rowOf)).toEqual([202, 202, 202]);
		expect(["c1", "c2", "c3", "c4"].map(rowOf)).toEqual([404, 404, 404, 404]);
		// 每段都从左侧开始。
		expect(at(layout, "r1")?.x).toBe(0);
		expect(at(layout, "c1")?.x).toBe(0);
	});

	it("相邻的两个节点不在同一组注释框里时多留 40 的间距，注释框互不重叠", () => {
		const layout = tidyLayout(phases);
		expect(["entry", "u1", "u2", "o1"].map((id) => at(layout, id)?.x)).toEqual([0, 340, 640, 980]);
		const boxes = annotationBoxes(laidOut(phases, layout)).map((b) => b.box);
		boxes.forEach((a, i) => {
			for (const b of boxes.slice(i + 1)) expect(overlap(a, b)).toBe(false);
		});
	});

	it("下一行的注释框有备注时行距再多留注释框的备注的位置；框外的标题不压住上一行的框", () => {
		const noted: TidyDocument = {
			...phases,
			annotations: phases.annotations?.map((a) =>
				a.id === "running" ? { ...a, note: "持续清洗日志，同时跑监控" } : a,
			),
		};
		const layout = tidyLayout(noted);
		expect(at(layout, "r1")?.y).toBe(202 + 68);
		expect(at(layout, "c1")?.y).toBe(202 + 68 + 202);
		const boxes = annotationBoxes(laidOut(noted, layout));
		const above = (id: string) => boxes.find((b) => b.annotation.id === id)?.box as never;
		const order = ["upgrade", "running", "closing"].map(above) as { y: number; h: number }[];
		for (let i = 1; i < order.length; i++) {
			const prev = order[i - 1] as { y: number; h: number };
			const next = order[i] as { y: number; h: number };
			expect(next.y - ANNOTATION_TITLE_SPACE).toBeGreaterThan(prev.y + prev.h);
		}
	});

	it("注释框里没有框进别的节点", () => {
		const doc = laidOut(phases, tidyLayout(phases));
		for (const box of annotationBoxes(doc)) expect(nonMembersInside(doc, box)).toEqual([]);
	});

	it("成员不挨着的注释框：中间的节点和成员排在一起，不拆到两行", () => {
		const doc: TidyDocument = {
			...mainChain(8),
			annotations: [annotation("a", { nodes: ["n2", "n6"] })],
		};
		const layout = tidyLayout(doc);
		const ys = ["n2", "n3", "n4", "n5", "n6"].map((id) => at(layout, id)?.y);
		expect(new Set(ys).size).toBe(1);
	});

	it("超过 5 个节点的注释框单独占几行，从左侧开始，后面的节点另起一行", () => {
		const doc: TidyDocument = {
			...mainChain(10),
			annotations: [annotation("a", { nodes: ["n2", "n3", "n4", "n5", "n6", "n7", "n8"] })],
		};
		const layout = tidyLayout(doc);
		expect(at(layout, "n1")?.y).toBe(0);
		// 7 个成员分两行：4 + 3。
		expect(at(layout, "n2")).toEqual({ x: 0, y: 202 });
		expect(at(layout, "n6")).toEqual({ x: 0, y: 404 });
		expect(at(layout, "n9")).toEqual({ x: 0, y: 606 });
		const laid = laidOut(doc, layout);
		for (const box of annotationBoxes(laid)) expect(nonMembersInside(laid, box)).toEqual([]);
	});
});

describe("整理布局：子流程排在触发它的那一行下面", () => {
	it("主链折行时，第一行触发的子流程排在第一行下面，第二行排在子流程下方", () => {
		// entry → n1 → go(异步) → n3 … n6；go 调度 sub → sub_a。7 个节点折成 4 + 3。
		const base = mainChain(7);
		const doc: StructureDocument = {
			nodes: [
				...base.nodes.map((n) => (n.id === "n2" ? node("n2", "async") : n)),
				node("sub", "subflow_entry"),
				node("sub_a"),
			],
			edges: [...base.edges, dispatch("n2", "sub"), chain("sub", "sub_a")],
		};
		const layout = tidyLayout(doc);
		expect(at(layout, "sub")).toEqual({ x: 834, y: 226 });
		expect(at(layout, "n4")).toEqual({ x: 0, y: 412 });
		expect(dispatchCrossings(doc, layout)).toEqual([]);
	});

	it("同一行触发的几个子流程：越靠右的触发节点，它的子流程排得越靠上，调度连线不从别的卡片下面经过", () => {
		// 子流程 run：run → a1 → a2 → a3 → mon，a1 / a2 / a3 各调度一个两节点的子流程。
		const doc: StructureDocument = {
			nodes: [
				node("entry", "entry"),
				node("go", "async"),
				node("run", "subflow_entry"),
				node("a1", "async"),
				node("a2", "async"),
				node("a3", "async"),
				node("mon"),
				...["s1", "s2", "s3"].flatMap((s) => [node(s, "subflow_entry"), node(`${s}_x`)]),
			],
			edges: [
				chain("entry", "go"),
				dispatch("go", "run"),
				chain("run", "a1"),
				chain("a1", "a2"),
				chain("a2", "a3"),
				chain("a3", "mon"),
				...["s1", "s2", "s3"].flatMap((s, i) => [dispatch(`a${i + 1}`, s), chain(s, `${s}_x`)]),
			],
		};
		const layout = tidyLayout(doc);
		const y = (id: string) => at(layout, id)?.y as number;
		expect(y("s3")).toBeLessThan(y("s2"));
		expect(y("s2")).toBeLessThan(y("s1"));
		expect(dispatchCrossings(doc, layout)).toEqual([]);
	});

	it("注释框包含子流程时，它所在的行到它为止，后面的节点排在子流程下方", () => {
		// entry → pre → go(异步) → post → tail；go 调度 sub → sub_a；注释框框住 go 和子流程 sub。
		const doc: TidyDocument = {
			nodes: [
				node("entry", "entry"),
				node("pre"),
				node("go", "async"),
				node("post"),
				node("tail"),
				node("sub", "subflow_entry"),
				node("sub_a"),
			],
			edges: [
				chain("entry", "pre"),
				chain("pre", "go"),
				chain("go", "post"),
				chain("post", "tail"),
				dispatch("go", "sub"),
				chain("sub", "sub_a"),
			],
			annotations: [annotation("run", { nodes: ["go"], subflows: ["sub"] })],
		};
		const layout = tidyLayout(doc);
		expect(at(layout, "go")?.y).toBe(0);
		expect(at(layout, "post")?.y).toBeGreaterThan(at(layout, "sub")?.y as number);
		const laid = laidOut(doc, layout);
		for (const box of annotationBoxes(laid)) expect(nonMembersInside(laid, box)).toEqual([]);
		expect(dispatchCrossings(doc, layout)).toEqual([]);
	});
});

describe("整理布局：注释框框住整棵子流程树", () => {
	it("注释框的子流程成员触发了下级子流程：下级子流程也排在框里，框里没有别的节点，后面的行排在整棵树下面", () => {
		// 全天测试的「运行阶段」：go(异步) 调度 run；run → w1 → w2，w1、w2 各调度一个下级子流程；
		// 注释框框住 go、tail_run 和子流程 run；后面还有收盘的 c1。
		const doc: TidyDocument = {
			nodes: [
				node("entry", "entry"),
				node("go", "async"),
				node("tail_run"),
				node("c1"),
				node("run", "subflow_entry"),
				node("w1", "async"),
				node("w2", "async"),
				node("k1", "subflow_entry"),
				node("k1_x"),
				node("k2", "subflow_entry"),
				node("k2_x"),
			],
			edges: [
				chain("entry", "go"),
				chain("go", "tail_run"),
				chain("tail_run", "c1"),
				dispatch("go", "run"),
				chain("run", "w1"),
				chain("w1", "w2"),
				dispatch("w1", "k1"),
				chain("k1", "k1_x"),
				dispatch("w2", "k2"),
				chain("k2", "k2_x"),
			],
			annotations: [
				annotation("running", { nodes: ["go", "tail_run"], subflows: ["run"] }),
				annotation("closing", { nodes: ["c1"], note: "出收盘报告" }),
			],
		};
		const layout = tidyLayout(doc);
		const laid = laidOut(doc, layout);
		const [running, closing] = annotationBoxes(laid);
		// 子流程下面那一行的注释框（连同框外的标题和框里的备注）不伸进上面的框。
		const runningBottom = (running?.box.y ?? 0) + (running?.box.h ?? 0);
		expect((closing?.box.y ?? 0) - ANNOTATION_TITLE_SPACE).toBeGreaterThan(runningBottom);
		expect(running?.members).toEqual([
			"go",
			"tail_run",
			"run",
			"w1",
			"w2",
			"k1",
			"k1_x",
			"k2",
			"k2_x",
		]);
		for (const box of annotationBoxes(laid)) expect(nonMembersInside(laid, box)).toEqual([]);
		expect(overlap(running?.box as never, closing?.box as never)).toBe(false);
		expect(at(layout, "c1")?.y).toBeGreaterThan(at(layout, "k1")?.y as number);
		expect(dispatchCrossings(doc, layout)).toEqual([]);
	});
});
