// 验收场景（docs/SEMANTICS.md §8）共用的小工具：编排构造、按链取节点、进程存活检查。
import type { ChainView, NodeView, RunView } from "./api-client.js";

export type DocNode = Record<string, unknown> & { id: string };

/** 桩节点包 sfly-stub@0.1.0 的包节点。 */
export const stub = (
	id: string,
	node: string,
	inputs: Record<string, unknown> = {},
	extra: Record<string, unknown> = {},
): DocNode => ({ id, kind: "package", package: "sfly-stub", node, inputs, ...extra });

/**
 * 由若干条链组成的编排：每条链是按顺序排列的节点（第一个是起点）；
 * dispatch 为 [异步任务节点, 子流程入口节点]。包版本锁定 sfly-stub@0.1.0（可以覆盖）。
 */
export function orchestration(
	defaultAgent: string,
	chains: DocNode[][],
	dispatch: Array<[string, string]> = [],
	packages: Record<string, string> = { "sfly-stub": "0.1.0" },
) {
	return {
		default_agent: defaultAgent,
		nodes: chains.flat(),
		edges: [
			...chains.flatMap((c) =>
				c.slice(1).map((n, i) => ({ from: c[i]?.id, to: n.id, kind: "chain" })),
			),
			...dispatch.map(([from, to]) => ({ from, to, kind: "dispatch" })),
		],
		packages,
	};
}

export function chainOf(run: RunView, chainId: string): ChainView {
	const chain = run.chains.find((c) => c.chain_id === chainId);
	if (!chain) throw new Error(`chain ${chainId} not in run ${run.id}`);
	return chain;
}

export function nodeOf(chain: ChainView, nodeId: string): NodeView {
	const node = chain.nodes.find((n) => n.node_id === nodeId);
	if (!node) throw new Error(`node ${nodeId} not in chain ${chain.chain_id}`);
	return node;
}

export const statuses = (chain: ChainView): Record<string, string> =>
	Object.fromEntries(chain.nodes.map((n) => [n.node_id, n.status]));

/** 进程是否还在（向它发 0 号信号）。 */
export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
