import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { AgentHub } from "../agents/agent-hub.js";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import type { Engine } from "../engine/engine.js";
import type { TaskLogs } from "../logs/task-logs.js";
import type { MetricQueries } from "../metrics/metric-queries.js";
import type { TaskMetrics } from "../metrics/task-metrics.js";
import type { OrchestrationStore } from "../orchestrations/orchestration-store.js";
import type { PackageRepository } from "../packages/package-repository.js";
import type { PresenceRegistry } from "../presence/presence-registry.js";
import type { Retention } from "../retention/retention.js";
import type { Preflight } from "../runs/preflight.js";
import type { SdkWheel } from "../sdk/sdk-wheels.js";
import { registerSse } from "../sse/sse.js";
import { registerArtifactRoutes } from "./artifact-routes.js";
import { sendError } from "./errors.js";
import { registerLogRoutes } from "./log-routes.js";
import { registerMetricRoutes } from "./metric-routes.js";
import { registerOrchestrationRoutes } from "./orchestration-routes.js";
import { registerPackageRoutes } from "./packages-routes.js";
import { registerPresenceRoutes } from "./presence-routes.js";
import { registerRunRoutes } from "./run-routes.js";
import { registerSdkRoutes } from "./sdk-routes.js";
import { registerWebApp, stripApiPrefix, type WebApp } from "./web-app.js";

export interface HttpApiDeps {
	database: Database;
	clock: Clock;
	logger: boolean;
	hub: AgentHub;
	orchestrations: OrchestrationStore;
	engine: Engine;
	packages: PackageRepository;
	presence: PresenceRegistry;
	preflight: Preflight;
	logs: TaskLogs;
	metrics: TaskMetrics;
	metricQueries: MetricQueries;
	retention: Retention;
	artifacts: ArtifactStore;
	/** Agent 共享注册令牌：设置后上传产物要带上它。 */
	agentToken?: string;
	/** HTTP API 对 Agent 可见的地址（产物引用用它拼下载地址）；监听之后才确定。 */
	publicHttpUrl: () => string;
	/** 可下载的 SDK 运行时 wheel。 */
	sdkWheels: readonly SdkWheel[];
	/** 前端构建产物（src/http/web-app.ts）；不设置时不提供页面。 */
	webApp?: WebApp;
}

const errorCode = (status: number): string =>
	({
		400: "invalid_request",
		404: "not_found",
		413: "payload_too_large",
		415: "unsupported_media_type",
	})[status] ?? "bad_request";

/** HTTP API（Fastify，HTTP/1.1）。路由按模块注册在这里。 */
export function buildHttpApi({
	database,
	clock,
	logger,
	hub,
	orchestrations,
	engine,
	packages,
	presence,
	preflight,
	logs,
	metrics,
	metricQueries,
	retention,
	artifacts,
	agentToken,
	publicHttpUrl,
	sdkWheels,
	webApp,
}: HttpApiDeps): FastifyInstance {
	// 浏览器经同源的 /api/* 访问 API 与 SSE（ADR 0006），根路径上的 API 供 Agent、CLI 使用。
	const app = Fastify({ logger, rewriteUrl: (req) => stripApiPrefix(req.url ?? "/") });
	if (webApp) registerWebApp(app, webApp);
	// SSE 推送（docs/ARCHITECTURE.md：运行状态、日志、在线编辑者），用法见 src/sse/sse.ts。
	const sse = registerSse(app);

	// Fastify 自身产生的错误（未知路由、请求体过大、JSON 解析失败等）也用统一的错误格式。
	app.setNotFoundHandler((request, reply) =>
		sendError(reply, 404, "not_found", `route ${request.method} ${request.url} not found`),
	);
	app.setErrorHandler((error: FastifyError, request, reply) => {
		const status = error.statusCode ?? 500;
		if (status >= 500) {
			request.log.error(error);
			return sendError(reply, status, "internal_error", "internal server error");
		}
		return sendError(reply, status, errorCode(status), error.message);
	});

	app.get("/health", async (_req, reply) => {
		const ok = await database.ping();
		return reply.code(ok ? 200 : 503).send({
			status: ok ? "ok" : "unavailable",
			database: ok ? "ok" : "unavailable",
			time: clock.now().toISOString(),
		});
	});

	app.get("/agents", async () => ({ agents: await hub.list() }));
	registerOrchestrationRoutes(app, { orchestrations, packages });
	registerRunRoutes(app, {
		db: database.db,
		engine,
		orchestrations,
		preflight,
		sse,
		progress: logs.progress,
		metrics: metrics.increments,
	});
	registerLogRoutes(app, { logs, sse, isPurged: (runId) => retention.isPurged(runId) });
	registerMetricRoutes(app, { metrics, queries: metricQueries });
	registerArtifactRoutes(app, { artifacts, agentToken, publicHttpUrl });
	registerPackageRoutes(app, packages);
	registerPresenceRoutes(app, { orchestrations, presence, sse });
	registerSdkRoutes(app, { wheels: sdkWheels, publicHttpUrl });

	return app;
}
