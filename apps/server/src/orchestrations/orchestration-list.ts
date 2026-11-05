import type {
	LastRun,
	OrchestrationDocument,
	OrchestrationSummary,
	ReferencedAgent,
} from "@sfly/schema";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "../db/database.js";
import { agents, orchestrations, orchestrationVersions, runs, tasks } from "../db/schema.js";
import { initialDocument, toView } from "./orchestration-store.js";

/** 场景列表的筛选（GET /orchestrations 的查询参数）。 */
export interface OrchestrationFilter {
	q?: string | undefined;
	status?: LastRun["status"] | undefined;
	agent?: string | undefined;
	archived?: boolean | undefined;
}

/** 场景引用的 Agent 名：默认 Agent 在前，其余（节点另选的）按名称排序。 */
export function referencedAgents(doc: OrchestrationDocument): { name: string; default: boolean }[] {
	const others = new Set<string>();
	for (const node of doc.nodes) {
		if (node.kind === "package" && node.agent && node.agent !== doc.default_agent) {
			others.add(node.agent);
		}
	}
	return [
		...(doc.default_agent ? [{ name: doc.default_agent, default: true }] : []),
		...[...others].sort().map((name) => ({ name, default: false })),
	];
}

/** 文档引用的 Agent 与在线状态（还没有注册过的为 unknown），顺序同 referencedAgents。 */
export async function referencedAgentStatus(
	db: Db,
	doc: OrchestrationDocument,
): Promise<ReferencedAgent[]> {
	const refs = referencedAgents(doc);
	if (refs.length === 0) return [];
	const status = new Map(
		(
			await db
				.select({ name: agents.name, status: agents.status })
				.from(agents)
				.where(
					inArray(
						agents.name,
						refs.map((a) => a.name),
					),
				)
		).map((a) => [a.name, a.status]),
	);
	return refs.map((a) => ({ ...a, status: status.get(a.name) ?? "unknown" }));
}

/**
 * 场景列表（卡片与表格的数据）：最新版本的结构与引用的 Agent（带在线状态）、最近一次运行与各节点状态。
 * 默认只列出没有归档的场景；archived 为 true 时只列出已归档的。按新建时间从新到旧。
 */
export async function listOrchestrationSummaries(
	db: Db,
	filter: OrchestrationFilter,
): Promise<{ orchestrations: OrchestrationSummary[]; archived_count: number }> {
	const rows = await db
		.select({
			orchestration: orchestrations,
			document: orchestrationVersions.document,
			savedAt: orchestrationVersions.createdAt,
		})
		.from(orchestrations)
		.leftJoin(
			orchestrationVersions,
			and(
				eq(orchestrationVersions.orchestrationId, orchestrations.id),
				eq(orchestrationVersions.number, orchestrations.headVersion),
			),
		)
		.where(
			filter.archived ? isNotNull(orchestrations.archivedAt) : isNull(orchestrations.archivedAt),
		)
		.orderBy(desc(orchestrations.createdAt), asc(orchestrations.name));
	const [archived] = await db
		.select({ n: count() })
		.from(orchestrations)
		.where(isNotNull(orchestrations.archivedAt));

	const ids = rows.map((r) => r.orchestration.id);
	const lastRuns =
		ids.length === 0
			? []
			: await db
					.selectDistinctOn([runs.orchestrationId], {
						run: runs,
						version: orchestrationVersions.number,
					})
					.from(runs)
					.innerJoin(
						orchestrationVersions,
						eq(orchestrationVersions.id, runs.orchestrationVersionId),
					)
					.where(inArray(runs.orchestrationId, ids))
					.orderBy(runs.orchestrationId, desc(runs.startedAt), desc(runs.id));
	const runIds = lastRuns.map((r) => r.run.id);
	const taskRows =
		runIds.length === 0
			? []
			: await db
					.select({ runId: tasks.runId, nodeId: tasks.nodeId, status: tasks.status })
					.from(tasks)
					.where(inArray(tasks.runId, runIds))
					.orderBy(asc(tasks.seq));
	// 同一节点有多条任务（重试、子流程的多个实例）时，后建的覆盖先建的。
	const nodeStates = new Map<string, Record<string, LastRun["node_states"][string]>>();
	for (const t of taskRows) {
		const states = nodeStates.get(t.runId) ?? {};
		states[t.nodeId] = t.status;
		nodeStates.set(t.runId, states);
	}
	const lastRunOf = new Map<string, LastRun>(
		lastRuns.map(({ run, version }) => [
			run.orchestrationId,
			{
				id: run.id,
				status: run.status,
				cancelling: run.status === "running" && run.cancelRequestedAt !== null,
				version,
				triggered_by: run.triggeredBy,
				started_at: run.startedAt.toISOString(),
				ended_at: run.endedAt ? run.endedAt.toISOString() : null,
				node_states: nodeStates.get(run.id) ?? {},
			},
		]),
	);
	const agentStatus = new Map(
		(await db.select({ name: agents.name, status: agents.status }).from(agents)).map((a) => [
			a.name,
			a.status,
		]),
	);

	const summaries = rows.map(({ orchestration, document, savedAt }): OrchestrationSummary => {
		const doc = document ?? initialDocument();
		const lastRun = lastRunOf.get(orchestration.id) ?? null;
		// 最新版本里还没有任务记录的节点补成 pending（缩略图按最新版本的结构着色）。
		if (lastRun) {
			for (const node of doc.nodes) lastRun.node_states[node.id] ??= "pending";
		}
		return {
			...toView(orchestration),
			updated_at: (savedAt ?? orchestration.createdAt).toISOString(),
			node_count: doc.nodes.length,
			subflow_count: doc.nodes.filter((n) => n.kind === "subflow_entry").length,
			structure: {
				nodes: doc.nodes.map((n) => ({ id: n.id, kind: n.kind })),
				edges: doc.edges.map((e) => ({ from: e.from, to: e.to, kind: e.kind })),
			},
			default_agent: doc.default_agent ?? null,
			agents: referencedAgents(doc).map(
				(a): ReferencedAgent => ({ ...a, status: agentStatus.get(a.name) ?? "unknown" }),
			),
			last_run: lastRun,
		};
	});

	const q = filter.q?.toLowerCase();
	return {
		orchestrations: summaries.filter(
			(s) =>
				(!q ||
					s.name.toLowerCase().includes(q) ||
					s.description.toLowerCase().includes(q) ||
					s.agents.some((a) => a.name.toLowerCase().includes(q))) &&
				(!filter.status || s.last_run?.status === filter.status) &&
				(!filter.agent || s.agents.some((a) => a.name === filter.agent)),
		),
		archived_count: archived?.n ?? 0,
	};
}
