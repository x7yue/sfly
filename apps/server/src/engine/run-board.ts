import type { NodeStatus, OrchestrationDocument } from "@sfly/schema";
import { asc, inArray } from "drizzle-orm";
import type { Db } from "../db/database.js";
import { type ChainStatus, chainInstances, type TaskProgress, tasks } from "../db/schema.js";
import { planRun } from "./chain.js";

/**
 * 节点状态的取法（运行视图 getRunView、运行列表、控制台共用）：一个链实例上一个节点的所有任务行
 * 按 attempt 升序，节点状态取最后一行（含跳过、未开始就取消的占位行）；还没有任务行时为 pending。
 */
export function groupAttempts<T extends { chainInstanceId: string; nodeId: string }>(
	rows: readonly T[],
): (chainInstanceId: string, nodeId: string) => T[] {
	const byNode = new Map<string, T[]>();
	for (const row of rows) {
		const key = `${row.chainInstanceId}/${row.nodeId}`;
		const list = byNode.get(key);
		if (list) list.push(row);
		else byNode.set(key, [row]);
	}
	return (chainInstanceId, nodeId) => byNode.get(`${chainInstanceId}/${nodeId}`) ?? [];
}

/** 节点状态：按 attempt 升序的任务行里最后一行的状态，没有任务行时为 pending。 */
export const nodeStatus = (rows: readonly { status: NodeStatus }[]): NodeStatus =>
	rows.at(-1)?.status ?? "pending";

export interface BoardNode {
	node_id: string;
	status: NodeStatus;
	/** 最后一次尝试的最新进度。 */
	progress: TaskProgress | null;
}

export interface BoardChain {
	id: string;
	chain_id: string;
	depth: number;
	status: ChainStatus;
	nodes: BoardNode[];
}

/**
 * 一批运行的链实例与各节点状态（运行列表、控制台用）：链与任务按整批读取，查询次数与运行数无关。
 * 每个链实例只列出它那条链（主链或子流程）上的节点，同一版本的文档只规划一次。
 */
export async function loadRunBoards(
	db: Db,
	items: ReadonlyArray<{ id: string; versionId: string; document: OrchestrationDocument }>,
): Promise<Map<string, BoardChain[]>> {
	const boards = new Map<string, BoardChain[]>(items.map((r) => [r.id, []]));
	if (items.length === 0) return boards;
	const ids = items.map((r) => r.id);
	const chains = await db
		.select({
			id: chainInstances.id,
			runId: chainInstances.runId,
			chainId: chainInstances.chainId,
			depth: chainInstances.depth,
			status: chainInstances.status,
		})
		.from(chainInstances)
		.where(inArray(chainInstances.runId, ids))
		.orderBy(asc(chainInstances.depth), asc(chainInstances.startedAt));
	const taskRows = await db
		.select({
			chainInstanceId: tasks.chainInstanceId,
			nodeId: tasks.nodeId,
			status: tasks.status,
			progress: tasks.progress,
		})
		.from(tasks)
		.where(inArray(tasks.runId, ids))
		.orderBy(asc(tasks.attempt));
	const attemptsOf = groupAttempts(taskRows);

	const plans = new Map<string, (chainId: string) => string[]>();
	const versionOf = new Map(items.map((r) => [r.id, r]));
	const nodesOf = (runId: string) => {
		const item = versionOf.get(runId);
		if (!item) return () => [];
		let plan = plans.get(item.versionId);
		if (!plan) {
			const planned = planRun(item.document);
			plan = (chainId) =>
				("errors" in planned ? undefined : planned.chains.get(chainId)?.nodes.map((n) => n.id)) ??
				[];
			plans.set(item.versionId, plan);
		}
		return plan;
	};

	for (const chain of chains) {
		const nodes = nodesOf(chain.runId)(chain.chainId).map((nodeId) => {
			const rows = attemptsOf(chain.id, nodeId);
			return {
				node_id: nodeId,
				status: nodeStatus(rows),
				progress: rows.at(-1)?.progress ?? null,
			};
		});
		boards.get(chain.runId)?.push({
			id: chain.id,
			chain_id: chain.chainId,
			depth: chain.depth,
			status: chain.status,
			nodes,
		});
	}
	return boards;
}
