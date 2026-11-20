import { runSummaryApi } from "@sfly/schema";
import type { FastifyInstance } from "fastify";
import { buildRunReport, type RunReportDeps } from "../runs/run-summary.js";
import { contractRoute } from "./contract-route.js";
import { sendError } from "./errors.js";

/** 一次运行的摘要（契约见 @sfly/schema 的 runSummaryApi，组装见 src/runs/run-summary.ts）。 */
export function registerRunSummaryRoutes(app: FastifyInstance, deps: RunReportDeps): void {
	contractRoute(app, runSummaryApi.summary, async ({ params }, reply) => {
		const report = await buildRunReport(deps, params.id);
		if (!report) return sendError(reply, 404, "not_found", "run not found");
		return report;
	});
}
