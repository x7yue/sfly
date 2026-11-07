import type { ChainRunView, ErrorView, NodeRunView, RunView } from "@sfly/schema";
import type { EdgeDecoration, NodeRunState } from "#/components/canvas/context";
import { NODE_STATUS } from "#/lib/node-status";
import { orderedChains } from "#/monitor/run-model";

/**
 * 画布「运行状态」模式（#41）的纯逻辑：把运行视图整理成按节点 ID 查询的叠加信息，
 * 供 FlowCanvas 的 decorateNode / decorateEdge / regionMeta 与运行状态检查器使用。
 */

export interface NodeRunSummary {
	/** 节点所在的链实例（子流程有多个实例时取第一个，与监控页 `?node=` 定位的实例一致）。 */
	chain: ChainRunView;
	node: NodeRunView;
	state: NodeRunState;
	/** 这个节点在运行里出现在几个链实例上（子流程实例数）。 */
	instances: number;
}

export interface RunOverlay {
	node(id: string): NodeRunSummary | undefined;
	edge(edge: { from: string; to: string; kind: "chain" | "dispatch" }): EdgeDecoration | undefined;
	/** 某个链起点（子流程入口）的所有实例，按层级与开始时间排列；没有触发过时为空。 */
	instances(chainId: string): ChainRunView[];
}

export function runOverlay(run: RunView): RunOverlay {
	const chains = orderedChains(run);
	const nodes = new Map<string, NodeRunSummary>();
	for (const chain of chains) {
		for (const node of chain.nodes) {
			const seen = nodes.get(node.node_id);
			if (seen) seen.instances += 1;
			else
				nodes.set(node.node_id, {
					chain,
					node,
					state: NODE_STATUS[node.status].canvas,
					instances: 1,
				});
		}
	}
	return {
		node: (id) => nodes.get(id),
		edge: ({ from, to, kind }) => {
			if (kind !== "chain" || nodes.get(from)?.state !== "done") return undefined;
			const target = nodes.get(to)?.state;
			return target === "running" ? "live" : target === "failed" ? "failed" : undefined;
		},
		instances: (chainId) => chains.filter((c) => c.chain_id === chainId),
	};
}

/** 节点耗时（毫秒）：第一次尝试开始到最后一次尝试结束，还没结束的算到 now；没有开始过时为 null。 */
export function nodeElapsed(node: NodeRunView, now: number): number | null {
	const started = node.attempts.flatMap((a) => (a.started_at ? [Date.parse(a.started_at)] : []));
	if (started.length === 0) return null;
	const last = node.attempts.at(-1);
	const end = last?.ended_at ? Date.parse(last.ended_at) : now;
	return Math.max(0, end - Math.min(...started));
}

/** 错误的一句话摘要：空行之后是堆栈，画布上不显示。 */
export const errorSummary = (error: ErrorView) => error.message.split(/\n\s*\n/)[0]?.trim() ?? "";
