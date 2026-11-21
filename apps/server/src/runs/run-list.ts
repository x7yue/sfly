import type { RunListItem, RunSummary } from "@sfly/schema";
import { and, count, desc, eq, ilike, or, type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/database.js";
import { orchestrationVersions, type RunStatus, runs } from "../db/schema.js";
import { runListPreset } from "../presets/run-preset.js";
import { type RunChain, type RunNode, type RunRead, readRuns } from "./run-read.js";

export interface RunListFilter {
	status?: RunStatus;
	orchestrationId?: string;
	/** 运行编号前缀或触发人（包含，不区分大小写）。 */
	q?: string;
	/** 触发人：昵称整个相等。 */
	triggeredBy?: string;
	/** 运行编号前缀（不分大小写，调用方保证只有十六进制数字和 `-`）。 */
	idPrefix?: string;
	limit: number;
}

/** LIKE 模式里按字面匹配。 */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * 跨场景的运行列表（契约见 @sfly/schema 的 runListApi）：按开始时间从新到旧，
 * 每项带各链的节点状态、进行中的节点与失败的链。链与任务按整页批量读取
 * （src/runs/run-read.ts，节点状态的取法与运行视图相同）。
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
	if (filter.triggeredBy) scope.push(eq(runs.triggeredBy, filter.triggeredBy));
	if (filter.idPrefix) scope.push(ilike(sql`${runs.id}::text`, `${escapeLike(filter.idPrefix)}%`));
	const where = filter.status ? [...scope, eq(runs.status, filter.status)] : scope;

	const page = await db
		.select({ id: runs.id })
		.from(runs)
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

	const reads = await readRuns(
		db,
		page.map((r) => r.id),
	);

	return {
		counts,
		// 运行不会被删除，每一个都读得到。
		runs: page.flatMap(({ id }): RunListItem[] => {
			const read = reads.get(id);
			if (!read) return [];
			const { run, chains } = read;
			const item: RunListItem = {
				id: run.id,
				orchestration_id: run.orchestrationId,
				orchestration_name: read.scenario.name,
				orchestration_version: read.version.number,
				status: run.status,
				cancelling: run.status === "running" && run.cancelRequestedAt !== null,
				triggered_by: run.triggeredBy,
				triggered_via: run.triggeredVia,
				preset: runListPreset(run),
				started_at: run.startedAt.toISOString(),
				ended_at: run.endedAt ? run.endedAt.toISOString() : null,
				chains: [],
				active_nodes: read.activeNodes,
				failures: chainFailures(read),
			};
			for (const chain of chains) {
				const subflow = chain.depth > 0;
				const nodes = chain.nodes.map(({ node_id, status }) => ({ node_id, status }));
				item.chains.push({
					id: chain.id,
					chain_id: chain.chain_id,
					subflow,
					subflow_name: chain.subflow_name,
					status: chain.status,
					nodes,
				});
			}
			return [item];
		}),
	};
}

/**
 * 失败的链实例（链失败或链上有节点最终失败），按失败的先后（运行读取的 `failures`）：有失败节点的链按它
 * 第一个失败的节点排，每条链带的就是这个节点，所以第一项是这次运行「第一个失败的节点」所在的链；链失败了却没有失败的节点
 * （例如参数校验失败）的排在最后，按链的顺序。
 */
function chainFailures({ chains, failures }: RunRead): RunListItem["failures"] {
	const first = new Map<RunChain, RunNode>();
	for (const { chain, node } of failures) {
		if (!first.has(chain)) first.set(chain, node);
	}
	const failed = [
		...first.keys(),
		...chains.filter((chain) => chain.status === "failed" && !first.has(chain)),
	];
	return failed.map((chain) => {
		const node = first.get(chain);
		return {
			chain_instance_id: chain.id,
			chain_id: chain.chain_id,
			subflow: chain.depth > 0,
			subflow_name: chain.subflow_name,
			node_id: node?.node_id ?? null,
			display_name: node?.display_name,
		};
	});
}

/** 一个场景的运行，按开始时间从新到旧（最多 limit 条）。 */
export async function listRuns(
	db: Db,
	orchestrationId: string,
	limit = 200,
): Promise<RunSummary[]> {
	const rows = await db
		.select({ run: runs, number: orchestrationVersions.number })
		.from(runs)
		.innerJoin(orchestrationVersions, eq(orchestrationVersions.id, runs.orchestrationVersionId))
		.where(eq(runs.orchestrationId, orchestrationId))
		.orderBy(desc(runs.startedAt), desc(runs.id))
		.limit(limit);
	return rows.map(({ run, number }) => ({
		id: run.id,
		orchestration_id: run.orchestrationId,
		orchestration_version: number,
		status: run.status,
		cancelling: run.status === "running" && run.cancelRequestedAt !== null,
		triggered_by: run.triggeredBy,
		triggered_via: run.triggeredVia,
		preset: runListPreset(run),
		started_at: run.startedAt.toISOString(),
		ended_at: run.endedAt ? run.endedAt.toISOString() : null,
	}));
}
