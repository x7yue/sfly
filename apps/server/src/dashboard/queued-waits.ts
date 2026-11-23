import type { DashboardActiveNode, RunListActiveNode } from "@sfly/schema";
import { inArray } from "drizzle-orm";
import { agentWaits, type QueueWaitHub } from "../agents/queue-wait.js";
import type { Db } from "../db/database.js";
import { tasks } from "../db/schema.js";
import type { ProjectId } from "../projects/project-id.js";
import type { RunRead } from "../runs/run-read.js";

/**
 * 控制台运行块里排队中的节点在等什么（`DashboardActiveNode` 的 `queue_wait`、`queued_at`）：和运行视图里排队中的尝试是同一份
 * 判断（`agents/queue-wait.ts` 的 `agentWaits`，读取这一刻按派发的条件算，不存库），排队超时的时间取任务上记的。
 * 额外的查询只在有排队中的节点时才有：每台被等的 Agent 一次（`agentWaits`），加一次按任务取排队超时的时间；没有排队中的节点时
 * 一条都不多。
 */
export async function withQueueWaits(
	db: Db,
	hub: QueueWaitHub,
	project: ProjectId,
	running: readonly RunRead[],
): Promise<Map<string, DashboardActiveNode[]>> {
	// 排队中的节点的最后一次尝试（进行中的节点的最后一行就是它最新的一次尝试）。
	const queued = running.flatMap(({ run, chains }) =>
		chains.flatMap((chain) =>
			chain.nodes.flatMap((node) => {
				const last = node.attempts.at(-1);
				return node.status === "queued" && last?.status === "queued" && last.agent
					? [
							{
								runId: run.id,
								chainId: chain.id,
								nodeId: node.node_id,
								attempt: last,
								agent: last.agent,
							},
						]
					: [];
			}),
		),
	);
	const waits =
		queued.length === 0
			? new Map()
			: await agentWaits(
					db,
					hub,
					queued.map((q) => q.agent),
					project,
				);
	const expiries =
		queued.length === 0
			? new Map<string, Date | null>()
			: new Map(
					(
						await db
							.select({ id: tasks.id, expiresAt: tasks.queueExpiresAt })
							.from(tasks)
							.where(
								inArray(
									tasks.id,
									queued.map((q) => q.attempt.taskId),
								),
							)
					).map((row) => [row.id, row.expiresAt]),
				);
	const waiting = new Map(queued.map((q) => [`${q.runId}/${q.chainId}/${q.nodeId}`, q] as const));
	return new Map(
		running.map(({ run, activeNodes }) => [
			run.id,
			activeNodes.map((node: RunListActiveNode): DashboardActiveNode => {
				const q = waiting.get(`${run.id}/${node.chain_instance_id}/${node.node_id}`);
				const wait = q && waits.get(q.agent);
				if (!q || !wait) return { ...node, queue_wait: null, queued_at: null };
				return {
					...node,
					queue_wait: {
						...wait,
						expires_at: expiries.get(q.attempt.taskId)?.toISOString() ?? null,
					},
					queued_at: q.attempt.queuedAt.toISOString(),
				};
			}),
		]),
	);
}
