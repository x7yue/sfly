import type { OrchestrationNode } from "@sfly/schema";
import { asc, desc, eq } from "drizzle-orm";
import type { Db } from "../db/database.js";
import { chainInstances, orchestrationVersions, runs, tasks } from "../db/schema.js";
import { agentFor, planMainChain } from "./chain.js";

export interface AttemptView {
	task_id: string;
	attempt: number;
	status: string;
	agent: string | null;
	inputs: Record<string, unknown> | null;
	outputs: Record<string, unknown> | null;
	error: { kind: string; message: string } | null;
	queued_at: string;
	started_at: string | null;
	ended_at: string | null;
}

export interface NodeView {
	node_id: string;
	kind: OrchestrationNode["kind"];
	/** 最近一次尝试的状态；还没有尝试时为 pending。 */
	status: string;
	/** 包节点派发到的 Agent；内置节点为 null。 */
	agent: string | null;
	outputs: Record<string, unknown> | null;
	error: { kind: string; message: string } | null;
	attempts: AttemptView[];
}

export interface ChainView {
	id: string;
	chain_id: string;
	parent_chain_instance_id: string | null;
	async_node_id: string | null;
	depth: number;
	status: string;
	params: Record<string, unknown>;
	started_at: string;
	ended_at: string | null;
	nodes: NodeView[];
}

export interface RunView {
	id: string;
	orchestration_id: string;
	orchestration_version: number;
	status: string;
	triggered_by: string;
	params: Record<string, unknown>;
	started_at: string;
	ended_at: string | null;
	chains: ChainView[];
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** 运行的只读查询：运行、链实例和每个节点的状态、输出与各次尝试。 */
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
	const plan = planMainChain(document);
	const chainNodes = "errors" in plan ? document.nodes : plan.nodes;

	return {
		id: run.id,
		orchestration_id: run.orchestrationId,
		orchestration_version: version.number,
		status: run.status,
		triggered_by: run.triggeredBy,
		params: run.params,
		started_at: run.startedAt.toISOString(),
		ended_at: iso(run.endedAt),
		chains: chains.map((chain) => ({
			id: chain.id,
			chain_id: chain.chainId,
			parent_chain_instance_id: chain.parentChainInstanceId,
			async_node_id: chain.asyncNodeId,
			depth: chain.depth,
			status: chain.status,
			params: chain.params,
			started_at: chain.startedAt.toISOString(),
			ended_at: iso(chain.endedAt),
			nodes: chainNodes.map((node) => {
				const attempts: AttemptView[] = allTasks
					.filter((t) => t.chainInstanceId === chain.id && t.nodeId === node.id)
					.map((t) => ({
						task_id: t.id,
						attempt: t.attempt,
						status: t.status,
						agent: t.agentName,
						inputs: t.inputs,
						outputs: t.outputs,
						error: t.errorKind ? { kind: t.errorKind, message: t.errorMessage ?? "" } : null,
						queued_at: t.queuedAt.toISOString(),
						started_at: iso(t.startedAt),
						ended_at: iso(t.endedAt),
					}));
				const last = attempts.at(-1);
				return {
					node_id: node.id,
					kind: node.kind,
					status: last?.status ?? "pending",
					agent: node.kind === "package" ? agentFor(document, node) : null,
					outputs: last?.outputs ?? null,
					error: last?.error ?? null,
					attempts,
				};
			}),
		})),
	};
}

/** 运行列表里的一项。 */
export interface RunSummary {
	id: string;
	orchestration_id: string;
	orchestration_version: number;
	status: string;
	triggered_by: string;
	started_at: string;
	ended_at: string | null;
}

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
