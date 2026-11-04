import { chainMembers } from "@sfly/orchestration";
import type { OrchestrationDocument } from "@sfly/schema";
import type { ChainRunView, NodeRunView, RunView } from "./api";

/**
 * 运行里的链实例与画布上的链（#13）：画布按编排文档画一次主链和每个子流程，
 * 每条链上的节点显示该链某一个实例的状态。
 */

/** 链起点节点 ID → 这条链在运行中的实例（按开始时间，控制面已排好序）。 */
export function instancesByChain(run: RunView): Map<string, ChainRunView[]> {
	const map = new Map<string, ChainRunView[]>();
	for (const chain of run.chains)
		map.set(chain.chain_id, [...(map.get(chain.chain_id) ?? []), chain]);
	return map;
}

/** 画布上显示的实例：选过的优先，否则第一个。 */
export function pickedInstance(
	instances: ReadonlyMap<string, ChainRunView[]>,
	picked: Readonly<Record<string, string>>,
	chainId: string,
): ChainRunView | undefined {
	const list = instances.get(chainId) ?? [];
	return list.find((c) => c.id === picked[chainId]) ?? list[0];
}

/** 节点 ID → 所在链的起点节点 ID。 */
export function chainOfNode(doc: OrchestrationDocument): Map<string, string> {
	const map = new Map<string, string>();
	for (const [start, ids] of chainMembers(doc)) for (const id of ids) map.set(id, start);
	return map;
}

/**
 * 节点 ID → 运行中的状态：每个节点取它所在链被选中的那个实例里的状态。
 * 还没有实例的链（子流程未被触发）上的节点没有状态，画布显示为待执行。
 */
export function nodeStates(
	run: RunView,
	doc: OrchestrationDocument,
	picked: Readonly<Record<string, string>>,
): Map<string, NodeRunView> {
	const instances = instancesByChain(run);
	const map = new Map<string, NodeRunView>();
	for (const start of chainMembers(doc).keys()) {
		for (const node of pickedInstance(instances, picked, start)?.nodes ?? []) {
			map.set(node.node_id, node);
		}
	}
	return map;
}
