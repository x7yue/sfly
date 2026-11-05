import {
	type CatalogNode,
	type MetricSummary,
	NodeTypeMetadata,
	type OrchestrationDocument,
	type RunMetricCatalog,
} from "@sfly/schema";
import { asc, eq } from "drizzle-orm";
import type { Clock } from "../clock.js";
import type { Db } from "../db/database.js";
import { metricSeries, orchestrationVersions, runs, tasks } from "../db/schema.js";
import { withDefaultCharts } from "../packages/default-charts.js";
import { isUuid } from "../util/uuid.js";
import { nodeTypeOf } from "./node-types.js";
import type { TaskMetrics } from "./task-metrics.js";

type TaskRow = typeof tasks.$inferSelect;

/** 被跳过的节点、还没开始就被取消的尝试只是占位，不算尝试（与运行视图一致）。 */
const isPlaceholder = (t: TaskRow) =>
	t.status === "skipped" || (t.status === "cancelled" && t.startedAt === null);

/**
 * 指标的只读查询（#31）：运行的指标目录、序列查询（降采样）、平台自带图表。
 * 原始数据见 src/metrics/task-metrics.ts（ADR 0009）。
 */
export class MetricQueries {
	constructor(
		private readonly deps: {
			db: Db;
			clock: Clock;
			/** 尚未写库的点在这里（序列查询要包括它们，断线重连后才能补齐）。 */
			metrics: TaskMetrics;
		},
	) {}

	/** 运行的指标目录；运行不存在时为 undefined。 */
	async catalog(runId: string): Promise<RunMetricCatalog | undefined> {
		const run = await this.#run(runId);
		if (!run) return undefined;
		const groups = this.#packageNodes(run.document, await this.#tasks(runId));
		const summaries = await this.#summaries(runId);
		const nodes: CatalogNode[] = [];
		for (const attempts of groups) {
			const latest = attempts[attempts.length - 1] as TaskRow;
			const ref = await nodeTypeOf(this.deps.db, run.document, latest.nodeId, latest.agentName);
			if (!ref) continue;
			const parsed = NodeTypeMetadata.safeParse(ref.type);
			const type = parsed.success ? withDefaultCharts(parsed.data) : undefined;
			nodes.push({
				chain_instance_id: latest.chainInstanceId,
				node_id: latest.nodeId,
				package: ref.package,
				node: ref.node,
				version: ref.version,
				metrics: type?.metrics ?? [],
				charts: type?.charts ?? [],
				primary_metric: type?.primary_metric ?? null,
				attempts: attempts.map((t) => ({
					task_id: t.id,
					attempt: t.attempt,
					truncated: t.metricTruncated,
					dropped_points: t.metricDropped,
					metrics: summaries.get(t.id) ?? [],
				})),
			});
		}
		return { run_id: runId, nodes };
	}

	async #run(
		runId: string,
	): Promise<{ document: OrchestrationDocument; run: typeof runs.$inferSelect } | undefined> {
		if (!isUuid(runId)) return undefined;
		const [row] = await this.deps.db
			.select({ run: runs, document: orchestrationVersions.document })
			.from(runs)
			.innerJoin(orchestrationVersions, eq(orchestrationVersions.id, runs.orchestrationVersionId))
			.where(eq(runs.id, runId));
		return row;
	}

	#tasks(runId: string): Promise<TaskRow[]> {
		return this.deps.db.select().from(tasks).where(eq(tasks.runId, runId)).orderBy(asc(tasks.seq));
	}

	/** 包节点的尝试（不含占位），按「链实例 × 节点」分组，组按第一次尝试的创建顺序。 */
	#packageNodes(document: OrchestrationDocument, rows: TaskRow[]): TaskRow[][] {
		const packageNodes = new Set(
			document.nodes.filter((n) => n.kind === "package").map((n) => n.id),
		);
		const groups = new Map<string, TaskRow[]>();
		for (const t of rows) {
			if (isPlaceholder(t) || !packageNodes.has(t.nodeId)) continue;
			const key = `${t.chainInstanceId}/${t.nodeId}`;
			const list = groups.get(key) ?? [];
			list.push(t);
			groups.set(key, list);
		}
		return [...groups.values()].map((list) => list.sort((a, b) => a.attempt - b.attempt));
	}

	/** 任务 ID → 已写库的指标摘要（按指标名排序）。 */
	async #summaries(runId: string): Promise<Map<string, MetricSummary[]>> {
		const rows = await this.deps.db
			.select()
			.from(metricSeries)
			.where(eq(metricSeries.runId, runId))
			.orderBy(asc(metricSeries.metric));
		const byTask = new Map<string, MetricSummary[]>();
		for (const row of rows) {
			const list = byTask.get(row.taskId) ?? [];
			list.push({
				name: row.metric,
				points: row.points,
				min: row.min,
				max: row.max,
				avg: row.sum / row.points,
				last: row.last,
				first_time: row.firstAt.toISOString(),
				last_time: row.lastAt.toISOString(),
			});
			byTask.set(row.taskId, list);
		}
		return byTask;
	}
}
