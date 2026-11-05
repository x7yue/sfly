import type {
	AttemptView,
	CatalogAttempt,
	CatalogNode,
	ChainRunView,
	MetricSeries,
	NodeRunView,
	RunView,
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
}

/** 有数据的节点：目录摘要或序列里有点。 */
export const groupHasData = (g: ChartGroup, series: MetricSeries | undefined) =>
	g.attempt.metrics.some((m) => m.points > 0) || !!series?.series.some((s) => s.buckets.length > 0);

export const ACTIVE = new Set(["running", "dispatched"]);
export const isActive = (g: ChartGroup) => ACTIVE.has(g.node.status);
export const isFailed = (g: ChartGroup) => g.node.status === "failed";

/** 分组按链上的执行顺序：链实例按层级（主链、子流程实例跟在派发它的链后面），链内按节点顺序。 */
export function buildGroups(run: RunView, catalog: readonly CatalogNode[]): ChartGroup[] {
	const byKey = new Map(
		catalog.map((n) => [nodeKey({ chainInstanceId: n.chain_instance_id, nodeId: n.node_id }), n]),
	);
	const out: ChartGroup[] = [];
	for (const chain of orderedChains(run)) {
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
			});
		}
	}
	return out;
}
