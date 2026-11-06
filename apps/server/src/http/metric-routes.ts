import { metricsApi } from "@sfly/schema";
import type { FastifyInstance } from "fastify";
import type { MetricQueries } from "../metrics/metric-queries.js";
import type { TaskMetrics } from "../metrics/task-metrics.js";
import { contractRoute } from "./contract-route.js";
import { sendError } from "./errors.js";

/**
 * 运行的指标（契约见 @sfly/schema 的 metricsApi）：摘要（#29）、目录、序列查询与平台自带图表（#31）。
 * 实时增量在运行事件流 `GET /runs/:id/events` 上（run-routes.ts）。
 */
export function registerMetricRoutes(
	app: FastifyInstance,
	deps: { metrics: TaskMetrics; queries: MetricQueries },
): void {
	contractRoute(
		app,
		metricsApi.summary,
		async ({ params }, reply) =>
			(await deps.metrics.summary(params.id)) ??
			sendError(reply, 404, "not_found", "run not found"),
	);

	contractRoute(
		app,
		metricsApi.catalog,
		async ({ params }, reply) =>
			(await deps.queries.catalog(params.id)) ??
			sendError(reply, 404, "not_found", "run not found"),
	);

	contractRoute(app, metricsApi.series, async ({ params, query }, reply) => {
		const outcome = await deps.queries.series(params.id, query);
		if (!outcome.ok) return sendError(reply, outcome.status, outcome.code, outcome.message);
		return outcome.series;
	});

	contractRoute(
		app,
		metricsApi.platform,
		async ({ params, query }, reply) =>
			(await deps.queries.platform(params.id, query.points)) ??
			sendError(reply, 404, "not_found", "run not found"),
	);
}
