import { agentsApi } from "./agents.js";
import type { RouteDef } from "./contract.js";
import { dashboardApi } from "./dashboard.js";
import { docsApi } from "./docs.js";
import { metricsApi } from "./metrics.js";
import { orchestrationsApi } from "./orchestrations.js";
import { packagesApi } from "./packages.js";
import { presenceApi } from "./presence.js";
import { runListApi } from "./run-list.js";
import { artifactsApi, logsApi, runsApi } from "./runs.js";
import { sdkApi, systemApi } from "./system.js";

export * from "./agents.js";
export * from "./contract.js";
export * from "./dashboard.js";
export * from "./docs.js";
export * from "./metrics.js";
export * from "./orchestrations.js";
export * from "./packages.js";
export * from "./presence.js";
export * from "./run-list.js";
export * from "./runs.js";
export * from "./system.js";

/**
 * 控制面的全部 HTTP 接口（约定 7）：控制面启动时检查注册的路由与这里一一对应
 * （apps/server/src/http/contract-route.ts 的 guardHttpContract）。新增接口表时加在这里。
 */
export const httpContract: readonly RouteDef[] = [
	agentsApi,
	artifactsApi,
	dashboardApi,
	docsApi,
	logsApi,
	metricsApi,
	orchestrationsApi,
	packagesApi,
	presenceApi,
	runListApi,
	runsApi,
	sdkApi,
	systemApi,
].flatMap((api) => Object.values(api) as RouteDef[]);
