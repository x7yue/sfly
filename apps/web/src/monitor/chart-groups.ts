import {
	type AttemptView,
	type CatalogAttempt,
	type CatalogNode,
	type ChainRunView,
	isOnAgentStatus,
	type MetricSeries,
	type NodeRunView,
	type RunView,
} from "@sfly/schema";
import type { StatusKind } from "#/components/status";
import { type NodeRef, nodeKey } from "./monitor-state";
import { nodeStatus, orderedChains } from "./run-model";

/** 图表工作区里的一个节点分组：目录里的包节点 × 运行视图里的节点。 */
export interface ChartGroup {
	key: string;
	ref: NodeRef;
	chain: ChainRunView;
	node: NodeRunView;
	entry: CatalogNode;
	/** 目录里最新的一次尝试（图表显示它）。 */
	attempt: CatalogAttempt;
	/** 运行视图里同一次尝试（开始、结束时间）。 */
	runAttempt: AttemptView | undefined;
	status: { kind: StatusKind; label: string };
	/** 子流程实例的简短名称：`子流程 sub`，同一子流程有多个实例时加序号（`#2`）；主链为 null。 */
	chainName: string | null;
}

/** 有数据的节点：目录摘要或序列里有点。 */
export const groupHasData = (g: ChartGroup, series: MetricSeries | undefined) =>
	g.attempt.metrics.some((m) => m.points > 0) || !!series?.series.some((s) => s.buckets.length > 0);

/** 还会继续上报指标的节点（任务在 Agent 上）。 */
export const isActive = (g: ChartGroup) => isOnAgentStatus(g.node.status);
export const isFailed = (g: ChartGroup) => g.node.status === "failed";

/** 分组按链上的执行顺序：链实例按层级（主链、子流程实例跟在派发它的链后面），链内按节点顺序。 */
export function buildGroups(run: RunView, catalog: readonly CatalogNode[]): ChartGroup[] {
	const byKey = new Map(
		catalog.map((n) => [nodeKey({ chainInstanceId: n.chain_instance_id, nodeId: n.node_id }), n]),
	);
	const out: ChartGroup[] = [];
	const chains = orderedChains(run);
	const instances = new Map<string, string[]>();
	for (const c of chains) instances.set(c.chain_id, [...(instances.get(c.chain_id) ?? []), c.id]);
	const chainName = (chain: ChainRunView) => {
		if (chain.depth === 0) return null;
		const ids = instances.get(chain.chain_id) ?? [];
		return ids.length > 1
			? `子流程 ${chain.chain_id} #${ids.indexOf(chain.id) + 1}`
			: `子流程 ${chain.chain_id}`;
	};
	for (const chain of chains) {
		for (const node of chain.nodes) {
			const ref = { chainInstanceId: chain.id, nodeId: node.node_id };
			const key = nodeKey(ref);
			const entry = byKey.get(key);
			const attempt = entry?.attempts.at(-1);
			if (!entry || !attempt || entry.charts.length === 0) continue;
			out.push({
				key,
				ref,
				chain,
				node,
				entry,
				attempt,
				runAttempt: node.attempts.find((a) => a.task_id === attempt.task_id),
				status: nodeStatus(node.status),
				chainName: chainName(chain),
			});
		}
	}
	return out;
}
