import type { OrchestrationDocument, RunListItem } from "@sfly/schema";
import { and, asc, count, desc, eq, ilike, inArray, or, type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/database.js";
import {
	chainInstances,
	orchestrations,
	orchestrationVersions,
	type RunStatus,
	runs,
	tasks,
} from "../db/schema.js";
import { planRun } from "../engine/chain.js";

export interface RunListFilter {
	status?: RunStatus;
	orchestrationId?: string;
	/** 运行编号前缀或触发人（包含，不区分大小写）。 */
	q?: string;
	limit: number;
}

/** 正在执行的节点状态：排队、派发中、执行中、等待唤醒。 */
const ACTIVE = new Set(["queued", "dispatched", "running", "waiting"]);

/** LIKE 模式里按字面匹配。 */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * 跨场景的运行列表（契约见 @sfly/schema 的 runListApi）：按开始时间从新到旧，
 * 每项带各链的节点状态、正在执行的节点与失败的链。链与任务按整页批量读取，
 * 节点状态的取法与运行视图（engine/run-queries.ts 的 getRunView）相同。
 */
export async function listAllRuns(
	db: Db,
	filter: RunListFilter,
): Promise<{ runs: RunListItem[]; counts: Record<RunStatus, number> }> {
	const scope: SQL[] = [];
	if (filter.orchestrationId) scope.push(eq(runs.orchestrationId, filter.orchestrationId));
	if (filter.q) {
		const q = escapeLike(filter.q);
		const match = or(ilike(sql`${runs.id}::text`, `${q}%`), ilike(runs.triggeredBy, `%${q}%`));
		if (match) scope.push(match);
	}
	const where = filter.status ? [...scope, eq(runs.status, filter.status)] : scope;

	const rows = await db
		.select({
			run: runs,
			name: orchestrations.name,
			version: orchestrationVersions.number,
			document: orchestrationVersions.document,
		})
		.from(runs)
		.innerJoin(orchestrations, eq(orchestrations.id, runs.orchestrationId))
		.innerJoin(orchestrationVersions, eq(orchestrationVersions.id, runs.orchestrationVersionId))
		.where(and(...where))
		.orderBy(desc(runs.startedAt), desc(runs.id))
		.limit(filter.limit);

	const grouped = await db
		.select({ status: runs.status, n: count() })
		.from(runs)
		.where(and(...scope))
		.groupBy(runs.status);
	const counts: Record<RunStatus, number> = { running: 0, success: 0, failed: 0, cancelled: 0 };
	for (const { status, n } of grouped) counts[status] = n;

	const ids = rows.map((r) => r.run.id);
	const chains =
		ids.length === 0
			? []
			: await db
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
	const taskRows =
		ids.length === 0
			? []
			: await db
					.select({
						chainInstanceId: tasks.chainInstanceId,
						nodeId: tasks.nodeId,
						status: tasks.status,
						progress: tasks.progress,
					})
					.from(tasks)
					.where(inArray(tasks.runId, ids))
					.orderBy(asc(tasks.attempt));
	// 每个链实例上每个节点的最后一次尝试（按 attempt 升序覆盖）。
	const latest = new Map<string, (typeof taskRows)[number]>();
	for (const t of taskRows) latest.set(`${t.chainInstanceId}/${t.nodeId}`, t);

	// 同一版本的文档只规划一次。
	const plans = new Map<string, (chainId: string) => string[]>();
	const chainNodes = (versionId: string, document: OrchestrationDocument) => {
		let nodesOf = plans.get(versionId);
		if (!nodesOf) {
			const plan = planRun(document);
			nodesOf = (chainId) =>
				("errors" in plan ? undefined : plan.chains.get(chainId)?.nodes.map((n) => n.id)) ?? [];
			plans.set(versionId, nodesOf);
		}
		return nodesOf;
	};

	return {
		counts,
		runs: rows.map(({ run, name, version, document }) => {
			const nodesOf = chainNodes(run.orchestrationVersionId, document);
			const item: RunListItem = {
				id: run.id,
				orchestration_id: run.orchestrationId,
				orchestration_name: name,
				orchestration_version: version,
				status: run.status,
				cancelling: run.status === "running" && run.cancelRequestedAt !== null,
				triggered_by: run.triggeredBy,
				started_at: run.startedAt.toISOString(),
				ended_at: run.endedAt ? run.endedAt.toISOString() : null,
				chains: [],
				active_nodes: [],
				failures: [],
			};
			for (const chain of chains) {
				if (chain.runId !== run.id) continue;
				const subflow = chain.depth > 0;
				const nodes = nodesOf(chain.chainId).map((nodeId) => {
					const task = latest.get(`${chain.id}/${nodeId}`);
					const status = task?.status ?? "pending";
					if (task && ACTIVE.has(status)) {
						item.active_nodes.push({
							chain_instance_id: chain.id,
							node_id: nodeId,
							status,
							progress: task.progress
								? { current: task.progress.current, total: task.progress.total }
								: null,
						});
					}
					return { node_id: nodeId, status };
				});
				const failedNode = nodes.find((n) => n.status === "failed");
				if (chain.status === "failed" || failedNode) {
					item.failures.push({
						chain_instance_id: chain.id,
						chain_id: chain.chainId,
						subflow,
						node_id: failedNode?.node_id ?? null,
					});
				}
				item.chains.push({
					id: chain.id,
					chain_id: chain.chainId,
					subflow,
					status: chain.status,
					nodes,
				});
			}
			return item;
		}),
	};
}
