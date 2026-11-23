import {
	DASHBOARD_ENDED_FOCUS_MAX,
	type DashboardEndedRun,
	type DashboardRunFailure,
	type DashboardView,
	isOnAgentStatus,
	type RunFocusItem,
} from "@sfly/schema";
import { and, count, desc, eq, gt, gte, isNotNull, lte } from "drizzle-orm";
import type { AgentHub } from "../agents/agent-hub.js";
import type { Db } from "../db/database.js";
import {
	chainInstances,
	orchestrations,
	orchestrationVersions,
	runs,
	type TaskStatus,
} from "../db/schema.js";
import { type RunFocusDeps, resolveRunFocus } from "../focus/run-focus.js";
import type { ProjectId } from "../projects/project-id.js";
import { type RunRead, type RunReadFull, readRuns } from "../runs/run-read.js";
import { withQueueWaits } from "./queued-waits.js";
import { setupSummary } from "./setup-summary.js";

const HOUR_MS = 3_600_000;
/** 最近结束最多列出的条数。 */
const RECENT_ENDED = 10;
const WINDOW_MS = 24 * HOUR_MS;

export interface DashboardDeps extends RunFocusDeps {
	hub: AgentHub;
}

type Outcome = "success" | "failed" | "cancelled";
const OUTCOMES: readonly Outcome[] = ["success", "failed", "cancelled"];
const isOutcome = (status: string): status is Outcome => (OUTCOMES as string[]).includes(status);

/**
 * 控制台统计（契约见 @sfly/schema 的 dashboardApi）。「现在」取注入的时钟，
 * 窗口是 [now − 24h, now]，运行按结束时间归入窗口。只统计这个项目里的运行、Agent、节点包和场景（ADR 0029）。
 */
export async function dashboardView(
	deps: DashboardDeps,
	project: ProjectId,
): Promise<DashboardView> {
	const { db, clock, hub } = deps;
	const now = clock.now();
	const windowStart = new Date(now.getTime() - WINDOW_MS);

	const ended = await db
		.select({ status: runs.status })
		.from(runs)
		.where(
			and(
				eq(runs.projectId, project),
				isNotNull(runs.endedAt),
				gte(runs.endedAt, windowStart),
				lte(runs.endedAt, now),
			),
		);
	const current = { success: 0, failed: 0, cancelled: 0 };
	for (const run of ended) {
		if (isOutcome(run.status)) current[run.status] += 1;
	}

	const running = await runningRuns(db, project);
	const activeNodes = await withQueueWaits(db, hub, project, running);
	const recentEnded = await recentEndedRuns(deps, project, windowStart, now);
	const failedSubflows = await failedSubflowCount(db, project, windowStart, now);
	const agents = await hub.list(project);
	const online = agents.filter((a) => a.status === "online");
	const chains = running.flatMap((r) => r.chains);
	const nodes = chains.flatMap((c) => c.nodes);

	return {
		generated_at: now.toISOString(),
		runs: {
			running: running.length,
			running_chains: chains.filter((c) => c.status === "running").length,
			running_tasks: nodes.filter((n) => isOnAgentStatus(n.status)).length,
			queued_tasks: nodes.filter((n) => n.status === ("queued" satisfies TaskStatus)).length,
			...current,
			failed_subflows: failedSubflows,
		},
		running_runs: running.map(({ run, scenario, version, chains }) => ({
			id: run.id,
			orchestration_id: run.orchestrationId,
			orchestration_name: scenario.name,
			orchestration_version: version.number,
			triggered_by: run.triggeredBy,
			triggered_via: run.triggeredVia,
			started_at: run.startedAt.toISOString(),
			cancelling: run.cancelRequestedAt !== null,
			chains: chains.map((chain) => ({
				id: chain.id,
				chain_id: chain.chain_id,
				subflow: chain.depth > 0,
				subflow_name: chain.subflow_name,
				parent_chain_instance_id: chain.parent_chain_instance_id,
				async_node_id: chain.async_node_id,
				status: chain.status,
				nodes: chain.nodes.map((n) => ({
					node_id: n.node_id,
					display_name: n.display_name,
					status: n.status,
				})),
			})),
			active_nodes: activeNodes.get(run.id) ?? [],
		})),
		recent_ended: recentEnded,
		agents: {
			online: online.length,
			offline: agents.length - online.length,
			slots: online.reduce((sum, a) => sum + a.info.slots, 0),
			used_slots: online.reduce((sum, a) => sum + a.running_tasks.length, 0),
		},
		setup: await setupSummary(db, project),
	};
}

/**
 * 正在运行的运行（按开始时间从新到旧）及其场景名称、各链节点状态；整批读取（src/runs/run-read.ts），
 * 查询次数与运行数无关。
 */
async function runningRuns(db: Db, project: ProjectId): Promise<RunRead[]> {
	const rows = await db
		.select({ id: runs.id })
		.from(runs)
		.where(and(eq(runs.projectId, project), eq(runs.status, "running")))
		.orderBy(desc(runs.startedAt), desc(runs.id));
	const reads = await readRuns(
		db,
		rows.map((r) => r.id),
	);
	return rows.flatMap(({ id }) => reads.get(id) ?? []);
}

/** 窗口内失败的子流程实例数（按链实例的结束时间，不论所在运行是否已结束）。 */
async function failedSubflowCount(
	db: Db,
	project: ProjectId,
	from: Date,
	to: Date,
): Promise<number> {
	const [row] = await db
		.select({ n: count() })
		.from(chainInstances)
		.innerJoin(runs, eq(runs.id, chainInstances.runId))
		.where(
			and(
				eq(runs.projectId, project),
				eq(chainInstances.status, "failed"),
				gt(chainInstances.depth, 0),
				isNotNull(chainInstances.endedAt),
				gte(chainInstances.endedAt, from),
				lte(chainInstances.endedAt, to),
			),
		);
	return row?.n ?? 0;
}

/**
 * 失败的运行最先出问题的地方：第一个失败的节点（运行读取的 `failures`，运行监控的页头、运行记录、运行通知
 * 用同一份顺序）；之后失败的 always 清理节点不算。错误信息的 secret 值在读取时已打码。
 * 链失败就一定有节点最终失败（引擎按同一个条件判断），找不到时是数据不完整，返回 null。
 */
function firstFailure(read: RunReadFull): DashboardRunFailure | null {
	const [first] = read.failures;
	if (!first) return null;
	const { chain, node } = first;
	const attempt = node.attempts.at(-1);
	return {
		chain_instance_id: chain.id,
		chain_id: chain.chain_id,
		subflow: chain.depth > 0,
		subflow_name: chain.subflow_name,
		node_id: node.node_id,
		display_name: node.display_name,
		attempt: attempt?.attempt ?? 0,
		error: attempt?.error ?? null,
	};
}

/**
 * 失败的运行在结束时的关注项读数：场景现在的关注项（`resolveRunFocus`，和 `GET /runs/:id/focus?points=0` 同一份规则）的
 * 前 {@link DASHBOARD_ENDED_FOCUS_MAX} 项。运行已经结束，场景没设关注项时读数是空的（主指标只取执行中的节点），
 * 所以只取关注项模式的读数。
 */
async function endedFocus(deps: RunFocusDeps, read: RunReadFull): Promise<RunFocusItem[]> {
	const focus = await resolveRunFocus(deps, read, { points: 0 });
	return focus.mode === "focus" ? focus.items.slice(0, DASHBOARD_ENDED_FOCUS_MAX) : [];
}

/** 窗口内结束的运行（按结束时间从新到旧，最多 RECENT_ENDED 个）；失败的带上最先出问题的节点和关注项的最终值。 */
async function recentEndedRuns(
	deps: RunFocusDeps,
	project: ProjectId,
	from: Date,
	to: Date,
): Promise<DashboardEndedRun[]> {
	const { db } = deps;
	const rows = await db
		.select({
			run: runs,
			name: orchestrations.name,
			version: orchestrationVersions.number,
		})
		.from(runs)
		.innerJoin(orchestrations, eq(orchestrations.id, runs.orchestrationId))
		.innerJoin(orchestrationVersions, eq(orchestrationVersions.id, runs.orchestrationVersionId))
		.where(
			and(
				eq(runs.projectId, project),
				isNotNull(runs.endedAt),
				gte(runs.endedAt, from),
				lte(runs.endedAt, to),
			),
		)
		.orderBy(desc(runs.endedAt), desc(runs.id))
		.limit(RECENT_ENDED);
	// 失败的运行（最多 RECENT_ENDED 个）整批读一次，再逐个读关注项的序列：不并发占用连接池，也不放进事务。
	const failed = await readRuns(
		db,
		rows.filter((r) => r.run.status === "failed").map((r) => r.run.id),
		"full",
	);
	const ended: DashboardEndedRun[] = [];
	for (const { run, name, version } of rows) {
		if (!run.endedAt || !isOutcome(run.status)) continue;
		const base = {
			id: run.id,
			orchestration_id: run.orchestrationId,
			orchestration_name: name,
			orchestration_version: version,
			triggered_by: run.triggeredBy,
			started_at: run.startedAt.toISOString(),
			ended_at: run.endedAt.toISOString(),
		};
		if (run.status !== "failed") {
			ended.push({ ...base, status: run.status });
			continue;
		}
		const read = failed.get(run.id);
		ended.push({
			...base,
			status: "failed",
			failure: read ? firstFailure(read) : null,
			focus: read ? await endedFocus(deps, read) : [],
		});
	}
	return ended;
}
