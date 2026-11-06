/**
 * 画布的键盘浏览（纯逻辑，单测见 navigation.test.ts）：方向键沿链切换选中的节点。
 *
 *   → / ←  沿链上的连线到下一个 / 上一个节点（链头、链尾停住）
 *   ↓      从异步任务节点进入它调度的子流程（选中子流程入口）
 *   ↑      从子流程里的任意节点回到调度它的异步任务节点
 *
 * 没有选中节点（或选中的节点已不存在）时，任意方向键选中主链入口。
 */

export interface ChainGraph {
	nodes: readonly { id: string; kind: string }[];
	edges: readonly { from: string; to: string; kind: "chain" | "dispatch" }[];
}

export type NavigationKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";

export const isNavigationKey = (key: string): key is NavigationKey =>
	key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown";

const isStart = (kind: string | undefined) => kind === "entry" || kind === "subflow_entry";

export function navigateChain(
	graph: ChainGraph,
	selected: string | null,
	key: NavigationKey,
): string | null {
	const kindOf = new Map(graph.nodes.map((n) => [n.id, n.kind]));
	if (selected === null || !kindOf.has(selected)) {
		return (graph.nodes.find((n) => n.kind === "entry") ?? graph.nodes[0])?.id ?? null;
	}
	const edge = (kind: "chain" | "dispatch", match: (e: ChainGraph["edges"][number]) => boolean) =>
		graph.edges.find((e) => e.kind === kind && kindOf.has(e.from) && kindOf.has(e.to) && match(e));

	switch (key) {
		case "ArrowRight":
			return edge("chain", (e) => e.from === selected)?.to ?? selected;
		case "ArrowLeft":
			return isStart(kindOf.get(selected))
				? selected
				: (edge("chain", (e) => e.to === selected)?.from ?? selected);
		case "ArrowDown":
			return kindOf.get(selected) === "async"
				? (edge("dispatch", (e) => e.from === selected)?.to ?? selected)
				: selected;
		case "ArrowUp": {
			// 沿入线回到链的起点；起点是子流程入口时，回到调度它的异步任务节点。
			const seen = new Set<string>();
			let id = selected;
			while (!isStart(kindOf.get(id)) && !seen.has(id)) {
				seen.add(id);
				const previous = edge("chain", (e) => e.to === id)?.from;
				if (previous === undefined) return selected;
				id = previous;
			}
			if (kindOf.get(id) !== "subflow_entry") return selected;
			return edge("dispatch", (e) => e.to === id)?.from ?? selected;
		}
	}
}
