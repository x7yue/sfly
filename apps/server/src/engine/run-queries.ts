import type { AttemptView, ChainRunView, NodeRunView, RunSummary, RunView } from "@sfly/schema";
import { asc, desc, eq } from "drizzle-orm";
import type { Db } from "../db/database.js";
import { chainInstances, orchestrationVersions, runs, tasks } from "../db/schema.js";
import { maskDeep, maskSecrets, secretValues } from "../logs/secrets.js";
import { agentFor, planRun } from "./chain.js";
import { groupAttempts, nodeStatus } from "./run-board.js";

/** 运行视图的类型来自 HTTP 契约（@sfly/schema 的 runsApi）。 */
export type { AttemptView, ChainRunView as ChainView, NodeRunView as NodeView, RunView };

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * 运行的只读查询：运行、链实例和每个节点的状态、输出与各次尝试。
 * 参数、输入、输出和错误信息里出现的 secret 值都已打码（src/logs/secrets.ts）。
 */
export async function getRunView(db: Db, runId: string): Promise<RunView | undefined> {
	const [row] = await db
		.select({ run: runs, version: orchestrationVersions })
		.from(runs)
		.innerJoin(orchestrationVersions, eq(orchestrationVersions.id, runs.orchestrationVersionId))
		.where(eq(runs.id, runId));
	if (!row) return undefined;
	const { run, version } = row;
	const document = version.document;
	const chains = await db
		.select()
		.from(chainInstances)
		.where(eq(chainInstances.runId, runId))
		.orderBy(asc(chainInstances.depth), asc(chainInstances.startedAt));
	const allTasks = await db
		.select()
		.from(tasks)
		.where(eq(tasks.runId, runId))
		.orderBy(asc(tasks.attempt));
	const attemptsOf = groupAttempts(allTasks);
	const plan = planRun(document);
	// 每个链实例只列出它那条链（主链或子流程）上的节点。
	const chainNodes = (chainId: string) =>
		("errors" in plan ? undefined : plan.chains.get(chainId)?.nodes) ?? [];
	const secrets = secretValues(document, chains);

	// 只打码用户内容（参数、输入、输出、错误信息），ID、状态、时间等字段原样返回。
	const m = <T>(value: T): T => maskDeep(value, secrets);
	const error = (kind: string | null, message: string | null) =>
		kind ? { kind, message: m(message ?? "") } : null;

	return {
		id: run.id,
		orchestration_id: run.orchestrationId,
		orchestration_version: version.number,
		status: run.status,
		triggered_by: run.triggeredBy,
		params: m(run.params),
		started_at: run.startedAt.toISOString(),
		ended_at: iso(run.endedAt),
		cancel: run.cancelRequestedAt
			? {
					requested_by: run.cancelRequestedBy ?? "",
					requested_at: run.cancelRequestedAt.toISOString(),
					forced_at: iso(run.cancelForcedAt),
				}
			: null,
		chains: chains.map((chain) => ({
			id: chain.id,
			chain_id: chain.chainId,
			parent_chain_instance_id: chain.parentChainInstanceId,
			async_node_id: chain.asyncNodeId,
			depth: chain.depth,
			status: chain.status,
			params: m(chain.params),
			started_at: chain.startedAt.toISOString(),
			ended_at: iso(chain.endedAt),
			nodes: chainNodes(chain.chainId).map((node) => {
				const rows = attemptsOf(chain.id, node.id);
				// 被跳过的节点、还没开始就被取消的尝试只是占位，不算尝试；节点状态取最后一行（含占位）。
				const placeholder = (t: (typeof rows)[number]) =>
					t.status === "skipped" || (t.status === "cancelled" && t.startedAt === null);
				const attempts: AttemptView[] = rows
					.filter((t) => !placeholder(t))
					.map((t) => ({
						task_id: t.id,
						attempt: t.attempt,
						status: t.status,
						agent: t.agentName,
						inputs: m(t.inputs),
						outputs: m(t.outputs),
						error: error(t.errorKind, t.errorMessage),
						queued_at: t.queuedAt.toISOString(),
						started_at: iso(t.startedAt),
						ended_at: iso(t.endedAt),
						wake_at: iso(t.wakeAt),
						progress: t.progress
							? { ...t.progress, message: maskSecrets(t.progress.message, secrets) }
							: null,
					}));
				const last = attempts.at(-1);
				return {
					node_id: node.id,
					kind: node.kind,
					status: nodeStatus(rows),
					agent: node.kind === "package" ? agentFor(document, node) : null,
					outputs: last?.outputs ?? null,
					error: last?.error ?? null,
					attempts,
				};
			}),
		})),
	};
}

export type { RunSummary };

/** 一份编排的运行，按开始时间从新到旧（最多 limit 条）。 */
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
		triggered_by: run.triggeredBy,
		started_at: run.startedAt.toISOString(),
		ended_at: iso(run.endedAt),
	}));
}
