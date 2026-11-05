import type { OrchestrationNode } from "@sfly/schema";
import { asc, desc, eq } from "drizzle-orm";
import type { Db } from "../db/database.js";
import {
	chainInstances,
	orchestrationVersions,
	runs,
	type TaskProgress,
	tasks,
} from "../db/schema.js";
import { maskDeep, maskSecrets, secretValues } from "../logs/secrets.js";
import { agentFor, planRun } from "./chain.js";

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
	/** 定时 / Sleep 节点的唤醒时间（#14）；其他节点为 null。 */
	wake_at: string | null;
	/** 最新进度（#10）；没有上报过时为 null。 */
	progress: TaskProgress | null;
}

export interface NodeView {
	node_id: string;
	kind: OrchestrationNode["kind"];
	/**
	 * 最近一次尝试的状态；还没有尝试时为 pending，被跳过时为 skipped，没开始就被取消时为 cancelled
	 * （这两种都没有尝试记录）。
	 */
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
	/** 取消请求（#12）；没有被取消时为 null。forced_at：清理期间再次取消（强制取消）的时间。 */
	cancel: { requested_by: string; requested_at: string; forced_at: string | null } | null;
	chains: ChainView[];
}

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
				const rows = allTasks.filter((t) => t.chainInstanceId === chain.id && t.nodeId === node.id);
				// 被跳过的节点、还没开始就被取消的尝试只是占位，不算尝试；节点状态取最后一行。
				const placeholder = (t: (typeof rows)[number]) =>
					t.status === "skipped" || (t.status === "cancelled" && t.startedAt === null);
				const latest = rows.at(-1);
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
						progress: t.progress ? { ...t.progress, message: maskSecrets(t.progress.message, secrets) } : null,
					}));
				const last = attempts.at(-1);
				return {
					node_id: node.id,
					kind: node.kind,
					status: latest?.status ?? "pending",
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
