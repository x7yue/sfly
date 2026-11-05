import type { RunMetricCatalog, RunMetricSummary } from "@sfly/schema";
import type { FastifyInstance } from "fastify";
import type { MetricQueries } from "../metrics/metric-queries.js";
import type { TaskMetrics } from "../metrics/task-metrics.js";
import { sendError } from "./errors.js";

/**
 * 运行的指标（契约在 @sfly/schema 的 metrics-api.ts）：
 * - `GET /runs/:id/metrics/summary` → {@link RunMetricSummary}（#29）：每个有指标数据的任务（每次尝试）每个指标的
 *   点数、最小、最大、平均、最新值、首尾时间，以及任务的截断标记。只包含已经写库的点（当前段约每 10 秒写一次，
 *   任务结束时立即写入）。
 * - `GET /runs/:id/metrics` → {@link RunMetricCatalog}（#31）：每个包节点的指标声明、图表定义（含默认图表）、
 *   主指标，以及每次尝试的摘要和截断标记。
 */
export function registerMetricRoutes(
	app: FastifyInstance,
	deps: { metrics: TaskMetrics; queries: MetricQueries },
): void {
	app.get<{ Params: { id: string } }>("/runs/:id/metrics/summary", async (request, reply) => {
		const summary: RunMetricSummary | undefined = await deps.metrics.summary(request.params.id);
		if (!summary) return sendError(reply, 404, "not_found", "run not found");
		return summary;
	});

	app.get<{ Params: { id: string } }>("/runs/:id/metrics", async (request, reply) => {
		const catalog: RunMetricCatalog | undefined = await deps.queries.catalog(request.params.id);
		if (!catalog) return sendError(reply, 404, "not_found", "run not found");
		return catalog;
	});
}
