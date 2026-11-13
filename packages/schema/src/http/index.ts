import { agentBinariesApi } from "./agent-binaries.js";
import { agentsApi } from "./agents.js";
import type { RouteDef } from "./contract.js";
import { dashboardApi } from "./dashboard.js";
import { docsApi } from "./docs.js";
import { feishuBotsApi } from "./feishu-bots.js";
import { metricsApi } from "./metrics.js";
import { orchestrationsApi } from "./orchestrations.js";
import { packagesApi } from "./packages.js";
import { presenceApi } from "./presence.js";
import { runListApi } from "./run-list.js";
import { artifactsApi, logsApi, runsApi } from "./runs.js";
import { sdkApi, systemApi } from "./system.js";

export * from "./agent-binaries.js";
export * from "./agents.js";
export * from "./clock-offset.js";
export * from "./contract.js";
export * from "./dashboard.js";
export * from "./docs.js";
export * from "./feishu-bots.js";
export * from "./metrics.js";
export * from "./orchestrations.js";
export * from "./packages.js";
export * from "./presence.js";
export * from "./run-list.js";
export * from "./runs.js";
export * from "./system.js";

export const httpApis = {
	agentBinaries: agentBinariesApi,
	agents: agentsApi,
	artifacts: artifactsApi,
	dashboard: dashboardApi,
	docs: docsApi,
	feishuBots: feishuBotsApi,
	logs: logsApi,
	metrics: metricsApi,
	orchestrations: orchestrationsApi,
	packages: packagesApi,
	presence: presenceApi,
	runs: { ...runListApi, ...runsApi },
	sdk: sdkApi,
	system: systemApi,
} satisfies Record<string, Record<string, RouteDef>>;

/**
 * 控制面的全部 HTTP 接口（约定 7）：控制面启动时检查注册的路由与这里一一对应
 * （apps/server/src/http/contract-route.ts 的 guardHttpContract）。
 */
export const httpContract: readonly RouteDef[] = Object.values(httpApis).flatMap(
	(api): RouteDef[] => Object.values(api),
);
