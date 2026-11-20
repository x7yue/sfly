import { dashboardApi } from "@sfly/schema";
import type { FastifyInstance } from "fastify";
import { type DashboardDeps, dashboardView } from "../dashboard/dashboard-stats.js";
import { DEFAULT_PROJECT } from "../projects/project-id.js";
import { contractRoute } from "./contract-route.js";

/** 控制台 API（契约见 @sfly/schema 的 dashboardApi）：GET /dashboard 最近 24 小时的统计。 */
export function registerDashboardRoutes(app: FastifyInstance, deps: DashboardDeps): void {
	// 路径还不带项目（#488）：统计默认项目。
	contractRoute(app, dashboardApi.get, () => dashboardView(deps, DEFAULT_PROJECT));
}
