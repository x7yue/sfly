// 由若干条链组成的测试场景（子流程、停止子流程节点的测试共用）。
import type { ChainView, RunView } from "./api-client.js";

export type Node = Record<string, unknown> & { id: string };

/** 包节点：stub/echo。 */
export const echo = (id: string, inputs: Record<string, unknown> = {}): Node => ({
	id,
	kind: "package",
	package: "stub",
	node: "echo",
	inputs,
});
export const spawn = (id: string, params: Record<string, unknown> = {}): Node => ({
	id,
	kind: "async",
	params,
});
export const param = (name: string, extra: Record<string, unknown> = {}) => ({
	name,
	type: "string",
	...extra,
});

/**
 * 由若干条链组成的编排：每条链是按顺序排列的节点（第一个是起点）；
 * dispatch 为 [异步任务节点, 子流程入口节点]。
 */
export function orchestration(chains: Node[][], dispatch: Array<[string, string]>) {
	return {
		default_agent: "agent-a",
		nodes: chains.flat(),
		edges: [
			...chains.flatMap((c) =>
				c.slice(1).map((n, i) => ({ from: c[i]?.id, to: n.id, kind: "chain" })),
			),
			...dispatch.map(([from, to]) => ({ from, to, kind: "dispatch" })),
		],
		packages: { stub: "1.0.0" },
	};
}

export const chainOf = (run: RunView, chainId: string): ChainView => {
	const chain = run.chains.find((c) => c.chain_id === chainId);
	if (!chain) throw new Error(`chain ${chainId} not in run ${run.id}`);
	return chain;
};
export const statuses = (chain: ChainView) =>
	Object.fromEntries(chain.nodes.map((n) => [n.node_id, n.status]));
