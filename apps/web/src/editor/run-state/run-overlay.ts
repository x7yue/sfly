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
			if (kind === "dispatch") {
				// 调度连线：子流程还有实例在运行时是青色虚线，结束了（或没有触发）就变灰，青色只留给正在发生的调度。
				return chains.some((c) => c.chain_id === to && c.status === "running") ? "live" : "ended";
			}
			// 线路图：走过的路段变亮，还没走到的暗下去，进入执行中 / 失败 / 等待中节点的那一段着状态色。
			if (nodes.get(from)?.state !== "done") return "ahead";
			const target = nodes.get(to)?.state;
			if (target === "running") return "live";
			if (target === "failed") return "failed";
			if (target === "waiting") return "waiting";
			if (target === "done" || target === "stopped") return "travelled";
			return "ahead";
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

/**
 * 卡片上的失败原因去掉开头的异常类名（`AssertionError: 漏拦 3 笔` → `漏拦 3 笔`）：卡片和站外一行只放得下
 * 十来个字，类名会占掉最有用的那一段；全文在悬停提示和检查器里。只有类名、或者类名不在开头时保留原文。
 */
export const withoutErrorClass = (reason: string) =>
	reason.replace(/^[A-Za-z_][\w.]*(?:Error|Exception)\s*[:：]\s*(?=\S)/, "");
