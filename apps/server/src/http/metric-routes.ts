import type { RunMetricSummary } from "@sfly/schema";
import type { FastifyInstance } from "fastify";
import type { TaskMetrics } from "../metrics/task-metrics.js";
import { sendError } from "./errors.js";

/**
 * 运行的指标摘要（#29）：`GET /runs/:id/metrics/summary` → {@link RunMetricSummary}（契约在 @sfly/schema）。
 * 每个有指标数据的任务（每次尝试）每个指标的点数、最小、最大、平均、最新值、首尾时间，以及任务的截断标记。
 * 只包含已经写库的点（当前段约每 10 秒写一次，任务结束时立即写入）。
 */
export function registerMetricRoutes(app: FastifyInstance, deps: { metrics: TaskMetrics }): void {
	app.get<{ Params: { id: string } }>("/runs/:id/metrics/summary", async (request, reply) => {
		const summary: RunMetricSummary | undefined = await deps.metrics.summary(request.params.id);
		if (!summary) return sendError(reply, 404, "not_found", "run not found");
		return summary;
	});
}
