import { dashboardApi } from "@sfly/schema";
import type { FastifyInstance } from "fastify";
import { type DashboardDeps, dashboardView } from "../dashboard/dashboard-stats.js";
import { contractRoute } from "./contract-route.js";

/** 控制台 API（契约见 @sfly/schema 的 dashboardApi）：GET /dashboard 最近 24 小时的统计。 */
export function registerDashboardRoutes(app: FastifyInstance, deps: DashboardDeps): void {
	contractRoute(app, dashboardApi.get, () => dashboardView(deps));
}
