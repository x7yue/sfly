import { isActiveStatus, type RunListItem } from "@sfly/schema";
import { and, count, desc, eq, ilike, or, type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/database.js";
import { orchestrations, orchestrationVersions, type RunStatus, runs } from "../db/schema.js";
import { loadRunBoards } from "../engine/run-board.js";

export interface RunListFilter {
	status?: RunStatus;
	orchestrationId?: string;
	/** 运行编号前缀或触发人（包含，不区分大小写）。 */
	q?: string;
	limit: number;
}

/** LIKE 模式里按字面匹配。 */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * 跨场景的运行列表（契约见 @sfly/schema 的 runListApi）：按开始时间从新到旧，
 * 每项带各链的节点状态、正在执行的节点与失败的链。链与任务按整页批量读取
 * （engine/run-board.ts，节点状态的取法与运行视图相同）。
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

	const boards = await loadRunBoards(
		db,
		rows.map(({ run, document }) => ({
			id: run.id,
			versionId: run.orchestrationVersionId,
			document,
		})),
	);

	return {
		counts,
		runs: rows.map(({ run, name, version }) => {
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
			for (const chain of boards.get(run.id) ?? []) {
				const subflow = chain.depth > 0;
				const nodes = chain.nodes.map(({ node_id, status, progress }) => {
					if (isActiveStatus(status)) {
						item.active_nodes.push({
							chain_instance_id: chain.id,
							node_id,
							status,
							progress: progress ? { current: progress.current, total: progress.total } : null,
						});
					}
					return { node_id, status };
				});
				const failedNode = nodes.find((n) => n.status === "failed");
				if (chain.status === "failed" || failedNode) {
					item.failures.push({
						chain_instance_id: chain.id,
						chain_id: chain.chain_id,
						subflow,
						node_id: failedNode?.node_id ?? null,
					});
				}
				item.chains.push({
					id: chain.id,
					chain_id: chain.chain_id,
					subflow,
					status: chain.status,
					nodes,
				});
			}
			return item;
		}),
	};
}
