import { describe, expect, it } from "vitest";
import { type ChainGraph, navigateChain } from "./navigation";

// 主链 entry → fetch → dispatch(async) → report；dispatch 调度子流程 sub → sub_a → sub_b；
// sub_a 再调度一个嵌套子流程 inner。
const graph: ChainGraph = {
	nodes: [
		{ id: "entry", kind: "entry" },
		{ id: "fetch", kind: "package" },
		{ id: "dispatch", kind: "async" },
		{ id: "report", kind: "package" },
		{ id: "sub", kind: "subflow_entry" },
		{ id: "sub_a", kind: "async" },
		{ id: "sub_b", kind: "package" },
		{ id: "inner", kind: "subflow_entry" },
		{ id: "orphan", kind: "package" },
	],
	edges: [
		{ from: "entry", to: "fetch", kind: "chain" },
		{ from: "fetch", to: "dispatch", kind: "chain" },
		{ from: "dispatch", to: "report", kind: "chain" },
		{ from: "dispatch", to: "sub", kind: "dispatch" },
		{ from: "sub", to: "sub_a", kind: "chain" },
		{ from: "sub_a", to: "sub_b", kind: "chain" },
		{ from: "sub_a", to: "inner", kind: "dispatch" },
	],
};

describe("键盘沿链切换节点", () => {
	it("没有选中节点时，任意方向键选中主链入口", () => {
		for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"] as const) {
			expect(navigateChain(graph, null, key)).toBe("entry");
		}
	});

	it("→ / ← 沿链上的连线前进、后退，到链头链尾停住", () => {
		expect(navigateChain(graph, "entry", "ArrowRight")).toBe("fetch");
		expect(navigateChain(graph, "fetch", "ArrowRight")).toBe("dispatch");
		// 异步任务节点向右沿主链继续，不进入子流程。
		expect(navigateChain(graph, "dispatch", "ArrowRight")).toBe("report");
		expect(navigateChain(graph, "report", "ArrowRight")).toBe("report");
		expect(navigateChain(graph, "report", "ArrowLeft")).toBe("dispatch");
		expect(navigateChain(graph, "entry", "ArrowLeft")).toBe("entry");
		expect(navigateChain(graph, "sub_b", "ArrowLeft")).toBe("sub_a");
		// 子流程入口向左不会回到主链。
		expect(navigateChain(graph, "sub", "ArrowLeft")).toBe("sub");
	});

	it("↓ 从异步任务节点进入它调度的子流程，↑ 从子流程里的任意节点回到调度它的异步任务节点", () => {
		expect(navigateChain(graph, "dispatch", "ArrowDown")).toBe("sub");
		expect(navigateChain(graph, "sub_b", "ArrowUp")).toBe("dispatch");
		expect(navigateChain(graph, "sub", "ArrowUp")).toBe("dispatch");
		// 嵌套：子流程里的异步任务节点继续向下，内层子流程向上回到外层。
		expect(navigateChain(graph, "sub_a", "ArrowDown")).toBe("inner");
		expect(navigateChain(graph, "inner", "ArrowUp")).toBe("sub_a");
	});

	it("没有可去的地方时停在原节点：主链上的 ↑、非异步任务节点的 ↓、没有连线的节点", () => {
		expect(navigateChain(graph, "fetch", "ArrowUp")).toBe("fetch");
		expect(navigateChain(graph, "fetch", "ArrowDown")).toBe("fetch");
		expect(navigateChain(graph, "orphan", "ArrowRight")).toBe("orphan");
		expect(navigateChain(graph, "orphan", "ArrowUp")).toBe("orphan");
	});

	it("选中的节点已被删除时回到主链入口", () => {
		expect(navigateChain(graph, "gone", "ArrowRight")).toBe("entry");
	});
});
