import { nodeNameBeforeId, subflowName } from "@sfly/orchestration";
import {
	isActiveStatus,
	type NodeStatus,
	type OrchestrationDocument,
	type OrchestrationNode,
	type RunListActiveNode,
} from "@sfly/schema";
import { asc, inArray } from "drizzle-orm";
import type { Db } from "../db/database.js";
import {
	type ChainStatus,
	chainInstances,
	type TaskProgress,
	type TaskStatus,
	tasks,
} from "../db/schema.js";
import { planRun } from "./chain.js";
import type { Tx } from "./step.js";

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

/**
 * 这一行是不是占位，不是真正的一次尝试：被跳过的节点、还没开始就被取消或停止的尝试（例如子流程被停止时还在排队的重试）。
 * 运行视图、运行板、指标目录和关注项读数都按它数尝试；节点状态仍取最后一行（含占位）。
 */
export const isPlaceholderAttempt = (t: { status: TaskStatus; startedAt: Date | null }): boolean =>
	t.status === "skipped" ||
	((t.status === "cancelled" || t.status === "stopped") && t.startedAt === null);

/** 节点状态：按 attempt 升序的任务行里最后一行的状态，没有任务行时为 pending。 */
export const nodeStatus = (rows: readonly { status: NodeStatus }[]): NodeStatus =>
	rows.at(-1)?.status ?? "pending";

/** 链实例的子流程名称（链起点是子流程入口节点时，取自文档）；主链为 undefined。 */
export function subflowNameOf(
	document: OrchestrationDocument,
	chainId: string,
): string | undefined {
	const start = document.nodes.find((n) => n.id === chainId);
	return start?.kind === "subflow_entry" ? subflowName(start) : undefined;
}

/** 运行绑定版本里节点的显示名称（同运行视图里节点的 `display_name`）；没有这个节点或没有名称时为 undefined。 */
export function nodeNameIn(document: OrchestrationDocument, nodeId: string): string | undefined {
	const node = document.nodes.find((n) => n.id === nodeId);
	return node && nodeNameBeforeId(node);
}

/** 节点最后一次尝试（任务行）上控制台要用的字段。 */
export interface BoardAttempt {
	attempt: number;
	/** 任务的 Agent（agent_name）；内置节点为 null。 */
	agent: string | null;
	startedAt: Date | null;
	wakeAt: Date | null;
	/** 最新进度。 */
	progress: TaskProgress | null;
}

export interface BoardNode {
	node_id: string;
	/** 运行绑定版本里的显示名称（子流程入口节点是子流程名称）；没有时为 undefined。 */
	display_name: string | undefined;
	status: NodeStatus;
	/** 最后一次尝试；还没有任务行（pending）时为 null。 */
	last: BoardAttempt | null;
}

export interface BoardChain {
	id: string;
	chain_id: string;
	/** 运行绑定版本里的子流程名称（同运行视图里链实例的 name）；主链为 undefined。 */
	subflow_name: string | undefined;
	/** 派发这个子流程实例的异步任务节点所在的链实例；主链为 null。 */
	parent_chain_instance_id: string | null;
	/** 派发这个子流程实例的异步任务节点；主链为 null。 */
	async_node_id: string | null;
	depth: number;
	status: ChainStatus;
	nodes: BoardNode[];
}

/**
 * 一批运行的链实例与各节点状态（运行列表、控制台用）：链与任务按整批读取，查询次数与运行数无关。
 * 每个链实例只列出它那条链（主链或子流程）上的节点，同一版本的文档只规划一次。
 */
export async function loadRunBoards(
	db: Db | Tx,
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
			parentChainInstanceId: chainInstances.parentChainInstanceId,
			asyncNodeId: chainInstances.asyncNodeId,
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
			attempt: tasks.attempt,
			agentName: tasks.agentName,
			status: tasks.status,
			startedAt: tasks.startedAt,
			wakeAt: tasks.wakeAt,
			progress: tasks.progress,
		})
		.from(tasks)
		.where(inArray(tasks.runId, ids))
		.orderBy(asc(tasks.attempt));
	const attemptsOf = groupAttempts(taskRows);

	const plans = new Map<string, (chainId: string) => readonly OrchestrationNode[]>();
	const versionOf = new Map(items.map((r) => [r.id, r]));
	const nodesOf = (runId: string) => {
		const item = versionOf.get(runId);
		if (!item) return () => [];
		let plan = plans.get(item.versionId);
		if (!plan) {
			const planned = planRun(item.document);
			plan = (chainId) =>
				("errors" in planned ? undefined : planned.chains.get(chainId)?.nodes) ?? [];
			plans.set(item.versionId, plan);
		}
		return plan;
	};

	for (const chain of chains) {
		const nodes = nodesOf(chain.runId)(chain.chainId).map((node) => {
			const rows = attemptsOf(chain.id, node.id);
			const last = rows.at(-1);
			return {
				node_id: node.id,
				display_name: nodeNameBeforeId(node),
				status: nodeStatus(rows),
				last: last
					? {
							attempt: last.attempt,
							agent: last.agentName,
							startedAt: last.startedAt,
							wakeAt: last.wakeAt,
							progress: last.progress,
						}
					: null,
			};
		});
		const document = versionOf.get(chain.runId)?.document;
		boards.get(chain.runId)?.push({
			id: chain.id,
			chain_id: chain.chainId,
			subflow_name: document && subflowNameOf(document, chain.chainId),
			parent_chain_instance_id: chain.parentChainInstanceId,
			async_node_id: chain.asyncNodeId,
			depth: chain.depth,
			status: chain.status,
			nodes,
		});
	}
	return boards;
}

/** 一个运行里进行中的节点（排队、派发中、执行中、等待唤醒），按链与链上的顺序；运行列表与控制台共用。 */
export function activeNodesOf(chains: readonly BoardChain[]): RunListActiveNode[] {
	return chains.flatMap((chain) =>
		chain.nodes.flatMap(({ node_id, display_name, status, last }) => {
			// 进行中的节点一定有任务行。
			if (!last || !isActiveStatus(status)) return [];
			return {
				chain_instance_id: chain.id,
				node_id,
				display_name,
				status,
				attempt: last.attempt,
				agent: last.agent,
				started_at: last.startedAt?.toISOString() ?? null,
				wake_at: last.wakeAt?.toISOString() ?? null,
				progress: last.progress
					? { current: last.progress.current, total: last.progress.total }
					: null,
			};
		}),
	);
}
