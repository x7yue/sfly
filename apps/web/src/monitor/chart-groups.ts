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
import { nodeStatusView, type StatusKind } from "#/components/status";
import { chainLabel } from "#/lib/copy";
import { type NodeRef, nodeKey } from "./monitor-state";
import { orderedChains } from "./run-model";

/** 图表工作区里的一个节点分组：目录里的包节点 × 运行视图里的节点。 */
export interface ChartGroup {
	key: string;
	ref: NodeRef;
	chain: ChainRunView;
	node: NodeRunView;
	entry: CatalogNode;
	/** 图表显示的那次尝试：默认最新一次，可以切换到之前的尝试（故事 16）。 */
	attempt: CatalogAttempt;
	/** 显示的是不是最新一次尝试。 */
	latest: boolean;
	/** 运行视图里同一次尝试（开始、结束时间）。 */
	runAttempt: AttemptView | undefined;
	status: { kind: StatusKind; label: string };
	/** 子流程实例的简短名称：`子流程 sub`，同一子流程有多个实例时加序号（`#2`）；主链为 null。 */
	chainName: string | null;
}

/** 有数据的节点：目录摘要或这个节点已加载的序列查询里有点。 */
export const groupHasData = (g: ChartGroup, loaded: readonly MetricSeries[]) =>
	g.attempt.metrics.some((m) => m.points > 0) ||
	loaded.some((r) => r.series.some((s) => s.buckets.length > 0));

/** 还会继续上报指标的节点（任务在 Agent 上）。 */
export const isActive = (g: ChartGroup) => isOnAgentStatus(g.node.status);
export const isFailed = (g: ChartGroup) => g.node.status === "failed";

/**
 * 分组按链上的执行顺序：链实例按层级（主链、子流程实例跟在派发它的链后面），链内按节点顺序。
 * chosen：分组 key → 要看的尝试序号（没有或不存在时看最新一次）。
 */
export function buildGroups(
	run: RunView,
	catalog: readonly CatalogNode[],
	chosen: Readonly<Record<string, number>> = {},
): ChartGroup[] {
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
		const name = chainLabel({ chain_id: chain.chain_id, subflow: true, name: chain.name });
		return ids.length > 1 ? `${name} #${ids.indexOf(chain.id) + 1}` : name;
	};
	for (const chain of chains) {
		for (const node of chain.nodes) {
			const ref = { chainInstanceId: chain.id, nodeId: node.node_id };
			const key = nodeKey(ref);
			const entry = byKey.get(key);
			const newest = entry?.attempts.at(-1);
			if (!entry || !newest || entry.charts.length === 0) continue;
			const attempt = entry.attempts.find((a) => a.attempt === chosen[key]) ?? newest;
			const latest = attempt === newest;
			const runAttempt = node.attempts.find((a) => a.task_id === attempt.task_id);
			out.push({
				key,
				ref,
				chain,
				node,
				entry,
				attempt,
				latest,
				runAttempt,
				// 之前的尝试显示它自己的结果。
				status: nodeStatusView(latest ? node.status : (runAttempt?.status ?? node.status)),
				chainName: chainName(chain),
			});
		}
	}
	return out;
}

/**
 * 显示顺序：运行里有失败的节点时，失败节点的分组排在最前（先看出了什么问题），其余保持链上的执行顺序；
 * 没有失败的节点时原样返回。
 */
export function failedFirst(groups: readonly ChartGroup[]): readonly ChartGroup[] {
	if (!groups.some(isFailed)) return groups;
	return [...groups.filter(isFailed), ...groups.filter((g) => !isFailed(g))];
}
