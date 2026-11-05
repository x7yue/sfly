import type { DashboardFailure, DashboardView } from "@sfly/schema";
import { and, asc, desc, eq, gte, isNotNull, lte } from "drizzle-orm";
import type { AgentHub } from "../agents/agent-hub.js";
import type { Clock } from "../clock.js";
import type { Db } from "../db/database.js";
import {
	chainInstances,
	nodePackages,
	ON_AGENT,
	orchestrations,
	runs,
	type TaskStatus,
} from "../db/schema.js";
import { getRunView, type NodeView, type RunView } from "../engine/run-queries.js";
import type { OrchestrationStore } from "../orchestrations/orchestration-store.js";
import { packageLocks } from "../orchestrations/usage.js";

const HOUR_MS = 3_600_000;
/** 最近失败最多列出的条数。 */
const RECENT_FAILURES = 10;
/** 最近发布的节点包最多列出的版本数。 */
const RECENT_PACKAGES = 5;
const WINDOW_MS = 24 * HOUR_MS;

export interface DashboardDeps {
	db: Db;
	clock: Clock;
	hub: AgentHub;
	orchestrations: OrchestrationStore;
}

type Outcome = "success" | "failed" | "cancelled";
const OUTCOMES: readonly Outcome[] = ["success", "failed", "cancelled"];
const isOutcome = (status: string): status is Outcome => (OUTCOMES as string[]).includes(status);

const rate = (counts: Record<Outcome, number>) => {
	const ended = counts.success + counts.failed + counts.cancelled;
	return ended === 0 ? null : counts.success / ended;
};

/**
 * 控制台统计（契约见 @sfly/schema 的 dashboardApi）。「现在」取注入的时钟，
 * 窗口是 [now − 24h, now]，运行按结束时间归入窗口与小时桶。
 */
export async function dashboardView({
	db,
	clock,
	hub,
	orchestrations: store,
}: DashboardDeps): Promise<DashboardView> {
	const now = clock.now();
	const windowStart = new Date(now.getTime() - WINDOW_MS);
	const previousStart = new Date(windowStart.getTime() - WINDOW_MS);

	// 前一个窗口与本窗口内结束的运行。
	const ended = await db
		.select({ status: runs.status, endedAt: runs.endedAt })
		.from(runs)
		.where(and(isNotNull(runs.endedAt), gte(runs.endedAt, previousStart), lte(runs.endedAt, now)));
	const current = { success: 0, failed: 0, cancelled: 0 };
	const previous = { success: 0, failed: 0, cancelled: 0 };
	const hourly = Array.from({ length: 24 }, (_, i) => ({
		start: new Date(windowStart.getTime() + i * HOUR_MS).toISOString(),
		success: 0,
		failed: 0,
		cancelled: 0,
	}));
	for (const run of ended) {
		if (!run.endedAt || !isOutcome(run.status)) continue;
		if (run.endedAt < windowStart) {
			previous[run.status] += 1;
			continue;
		}
		current[run.status] += 1;
		// 恰好在此刻结束的运行归入最后一个桶。
		const index = Math.floor((run.endedAt.getTime() - windowStart.getTime()) / HOUR_MS);
		const bucket = hourly[Math.min(index, hourly.length - 1)];
		if (bucket) bucket[run.status] += 1;
	}

	const running = await runningRuns(db);
	const failures = await failedChains(db, windowStart, now);
	const agents = (await hub.list()).map((agent) => ({
		name: agent.name,
		status: agent.status,
		slots: agent.info.slots,
		used_slots: agent.running_tasks.length,
		installing:
			agent.status === "online" && agent.install?.state === "installing"
				? { package: agent.install.package, version: agent.install.version }
				: null,
		last_seen_at: agent.last_seen_at,
	}));
	const online = agents.filter((a) => a.status === "online");
	const published = await db
		.select({
			name: nodePackages.name,
			version: nodePackages.version,
			publishedAt: nodePackages.publishedAt,
		})
		.from(nodePackages)
		.orderBy(desc(nodePackages.publishedAt), asc(nodePackages.name), desc(nodePackages.version))
		.limit(RECENT_PACKAGES);
	const locks = packageLocks(await store.headDocuments());
	const chains = running.flatMap((r) => r.view.chains);
	const nodes = chains.flatMap((c) => c.nodes);
	const onAgent = (status: string) => (ON_AGENT as readonly string[]).includes(status);

	return {
		generated_at: now.toISOString(),
		runs: {
			running: running.length,
			running_chains: chains.filter((c) => c.status === "running").length,
			running_tasks: nodes.filter((n) => onAgent(n.status)).length,
			queued_tasks: nodes.filter((n) => n.status === ("queued" satisfies TaskStatus)).length,
			...current,
			failed_subflows: failures.subflows,
			success_rate: rate(current),
			previous_success_rate: rate(previous),
		},
		hourly,
		running_runs: running.map(({ view, name }) => ({
			id: view.id,
			orchestration_id: view.orchestration_id,
			orchestration_name: name,
			orchestration_version: view.orchestration_version,
			triggered_by: view.triggered_by,
			started_at: view.started_at,
			cancelling: view.cancel !== null,
			chains: view.chains.map((chain) => ({
				id: chain.id,
				chain_id: chain.chain_id,
				subflow: chain.depth > 0,
				status: chain.status,
				nodes: chain.nodes.map((n) => ({ node_id: n.node_id, status: n.status })),
			})),
		})),
		recent_failures: failures.recent,
		agents: {
			online: online.length,
			offline: agents.length - online.length,
			slots: online.reduce((sum, a) => sum + a.slots, 0),
			used_slots: online.reduce((sum, a) => sum + a.used_slots, 0),
			list: agents,
		},
		recent_packages: published.map((p) => ({
			name: p.name,
			version: p.version,
			published_at: p.publishedAt.toISOString(),
			locked_orchestrations: locks.get(`${p.name}@${p.version}`) ?? 0,
		})),
	};
}

/** 正在运行的运行（按开始时间从新到旧）及其场景名称。 */
async function runningRuns(db: Db): Promise<Array<{ view: RunView; name: string }>> {
	const rows = await db
		.select({ id: runs.id, name: orchestrations.name })
		.from(runs)
		.innerJoin(orchestrations, eq(orchestrations.id, runs.orchestrationId))
		.where(eq(runs.status, "running"))
		.orderBy(desc(runs.startedAt), desc(runs.id));
	const views = await Promise.all(rows.map((row) => getRunView(db, row.id)));
	return rows.flatMap((row, i) => {
		const view = views[i];
		return view ? [{ view, name: row.name }] : [];
	});
}

/**
 * 窗口内失败（按结束时间）的链实例，从新到旧：失败的子流程总数与最近的若干条。
 * 失败节点取最后一次尝试失败、最先结束的节点（之后失败的 always 清理节点不算）；
 * 错误信息取自运行视图，其中的 secret 值已打码。
 */
async function failedChains(
	db: Db,
	from: Date,
	to: Date,
): Promise<{ subflows: number; recent: DashboardFailure[] }> {
	const chains = await db
		.select({
			chain: chainInstances,
			orchestrationId: runs.orchestrationId,
			name: orchestrations.name,
		})
		.from(chainInstances)
		.innerJoin(runs, eq(runs.id, chainInstances.runId))
		.innerJoin(orchestrations, eq(orchestrations.id, runs.orchestrationId))
		.where(
			and(
				eq(chainInstances.status, "failed"),
				isNotNull(chainInstances.endedAt),
				gte(chainInstances.endedAt, from),
				lte(chainInstances.endedAt, to),
			),
		)
		.orderBy(desc(chainInstances.endedAt), desc(chainInstances.id));
	const recent = chains.slice(0, RECENT_FAILURES);
	const views = new Map<string, RunView | undefined>();
	for (const { chain } of recent) {
		if (!views.has(chain.runId)) views.set(chain.runId, await getRunView(db, chain.runId));
	}
	return {
		subflows: chains.filter(({ chain }) => chain.depth > 0).length,
		recent: recent.map(({ chain, orchestrationId, name }) => {
			const view = views.get(chain.runId);
			const endedAt = (node: NodeView) => node.attempts.at(-1)?.ended_at ?? "";
			const [first] = (view?.chains.find((c) => c.id === chain.id)?.nodes ?? [])
				.filter((n) => n.status === "failed")
				.sort((a, b) => endedAt(a).localeCompare(endedAt(b)));
			return {
				run_id: chain.runId,
				orchestration_id: orchestrationId,
				orchestration_name: name,
				run_status: view?.status ?? "failed",
				chain_instance_id: chain.id,
				chain_id: chain.chainId,
				subflow: chain.depth > 0,
				node_id: first?.node_id ?? null,
				error: first?.error ?? null,
				failed_at: (chain.endedAt ?? to).toISOString(),
			};
		}),
	};
}
