import { authApi, usersApi } from "./accounts.js";
import { actionsApi } from "./actions.js";
import { agentBinariesApi } from "./agent-binaries.js";
import { agentsApi } from "./agents.js";
import { clientPackageApi } from "./client-package.js";
import type { RouteDef } from "./contract.js";
import { dashboardApi } from "./dashboard.js";
import { docsApi } from "./docs.js";
import { feishuBotsApi } from "./feishu-bots.js";
import { metricsApi } from "./metrics.js";
import { orchestrationsApi } from "./orchestrations.js";
import { packagesApi } from "./packages.js";
import { presetsApi } from "./presets.js";
import { runFocusApi } from "./run-focus.js";
import { runListApi } from "./run-list.js";
import { runSummaryApi } from "./run-summary.js";
import { artifactsApi, logsApi, runsApi } from "./runs.js";
import { sdkApi, systemApi } from "./system.js";
import { tokensApi } from "./tokens.js";

export * from "./accounts.js";
export * from "./actions.js";
export * from "./agent-binaries.js";
export * from "./agents.js";
export * from "./client-package.js";
export * from "./clock-offset.js";
export * from "./contract.js";
export * from "./dashboard.js";
export * from "./declarations.js";
export * from "./docs.js";
export * from "./feishu-bots.js";
export * from "./metrics.js";
export * from "./orchestrations.js";
export * from "./packages.js";
export * from "./presets.js";
export * from "./run-focus.js";
export * from "./run-list.js";
export * from "./run-summary.js";
export * from "./runs.js";
export * from "./system.js";
export * from "./tokens.js";

export const httpApis = {
	actions: actionsApi,
	agentBinaries: agentBinariesApi,
	agents: agentsApi,
	artifacts: artifactsApi,
	auth: authApi,
	clientPackage: clientPackageApi,
	dashboard: dashboardApi,
	docs: docsApi,
	feishuBots: feishuBotsApi,
	logs: logsApi,
	metrics: metricsApi,
	orchestrations: orchestrationsApi,
	packages: packagesApi,
	presets: presetsApi,
	runs: { ...runListApi, ...runFocusApi, ...runSummaryApi, ...runsApi },
	sdk: sdkApi,
	system: systemApi,
	tokens: tokensApi,
	users: usersApi,
} satisfies Record<string, Record<string, RouteDef>>;

/**
 * 控制面的全部 HTTP 接口（约定 7）：控制面启动时检查注册的路由与这里一一对应
 * （apps/server/src/http/contract-route.ts 的 guardHttpContract）。
 */
export const httpContract: readonly RouteDef[] = Object.values(httpApis).flatMap(
	(api): RouteDef[] => Object.values(api),
);
