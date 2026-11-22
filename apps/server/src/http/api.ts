import {
	CONTROL_PLANE_TIME_HEADER,
	CONTROL_PLANE_VERSION_HEADER,
	httpContract,
	systemApi,
} from "@sfly/schema";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { TaskActions } from "../actions/task-actions.js";
import type { AgentBinaries } from "../agent-binaries/agent-binaries.js";
import type { AgentHub } from "../agents/agent-hub.js";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import { AccessGuard } from "../auth/access-guard.js";
import { DbAccessStore } from "../auth/access-store.js";
import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import type { UserDocs } from "../docs/user-docs.js";
import type { ClientTarball } from "../downloads/client-tarballs.js";
import type { Engine } from "../engine/engine.js";
import type { FeishuBots } from "../feishu/feishu-bots.js";
import type { FeishuClient } from "../feishu/feishu-client.js";
import { RunLogs } from "../logs/run-log-pages.js";
import type { TaskLogs } from "../logs/task-logs.js";
import type { MetricQueries } from "../metrics/metric-queries.js";
import type { TaskMetrics } from "../metrics/task-metrics.js";
import type { OrchestrationStore } from "../orchestrations/orchestration-store.js";
import type { PackageRepository } from "../packages/package-repository.js";
import type { StdIndex } from "../packages/std-index.js";
import type { PresetStore } from "../presets/preset-store.js";
import type { PublicConfig } from "../public-config.js";
import type { Retention } from "../retention/retention.js";
import type { Preflight } from "../runs/preflight.js";
import type { SdkWheel } from "../sdk/sdk-wheels.js";
import { registerSse } from "../sse/sse.js";
import { installAccessGuard } from "./access.js";
import { registerActionRoutes } from "./action-routes.js";
import { registerAgentBinaryRoutes } from "./agent-binary-routes.js";
import { registerAgentRoutes } from "./agent-routes.js";
import { registerArtifactRoutes } from "./artifact-routes.js";
import { registerClientPackageRoutes } from "./client-package-routes.js";
import { contractRoute, guardHttpContract } from "./contract-route.js";
import { registerCors } from "./cors.js";
import { registerDashboardRoutes } from "./dashboard-routes.js";
import { registerDocsRoutes } from "./docs-routes.js";
import { sendError } from "./errors.js";
import { registerFeishuBotRoutes } from "./feishu-bot-routes.js";
import { registerLogRoutes } from "./log-routes.js";
import { registerMetricRoutes } from "./metric-routes.js";
import { registerOrchestrationRoutes } from "./orchestration-routes.js";
import { registerPackageRoutes } from "./packages-routes.js";
import { registerPresetRoutes } from "./preset-routes.js";
import { registerRunFocusRoutes } from "./run-focus-routes.js";
import { registerRunListRoutes } from "./run-list-routes.js";
import { registerRunRoutes } from "./run-routes.js";
import { registerRunSummaryRoutes } from "./run-summary-routes.js";
import { registerSdkRoutes } from "./sdk-routes.js";
import { registerWebApp, stripApiPrefix, type WebApp } from "./web-app.js";

export interface HttpApiDeps {
	database: Database;
	clock: Clock;
	logger: boolean;
	hub: AgentHub;
	orchestrations: OrchestrationStore;
	/** 运行预设（src/presets/，ADR 0024）。 */
	presets: PresetStore;
	engine: Engine;
	packages: PackageRepository;
	preflight: Preflight;
	logs: TaskLogs;
	/** 任务的动作（src/actions/）。 */
	actions: TaskActions;
	metrics: TaskMetrics;
	metricQueries: MetricQueries;
	retention: Retention;
	artifacts: ArtifactStore;
	/** Agent 共享注册令牌：设置后上传产物要带上它。 */
	agentToken?: string;
	/** 对外公开的地址、版本号和镜像（产物引用、Agent 下载与 install.sh、sfly 索引、文档占位符用）。 */
	publicConfig: PublicConfig;
	/** 可下载的 SDK 运行时 wheel。 */
	sdkWheels: readonly SdkWheel[];
	/** 控制面的包索引里的标准节点包 sfly-std（公共项目里已发布的版本）。 */
	stdIndex: StdIndex;
	clientTarballs: readonly ClientTarball[];
	/** 可下载的 Agent 二进制与 install.sh 模板（src/agent-binaries/）。 */
	agentBinaries: AgentBinaries;
	installScript: string;
	/** 用户文档（src/docs/user-docs.ts）。 */
	docs: UserDocs;
	/** 飞书机器人与向飞书发请求的客户端（src/feishu/，ADR 0020）。 */
	feishuBots: FeishuBots;
	feishu: FeishuClient;
	/** 前端构建产物（src/http/web-app.ts）；不设置时不提供页面。 */
	webApp?: WebApp;
	/** 允许跨域调用的来源名单（src/http/cors.ts）；不设置时允许所有来源。 */
	corsOrigins?: readonly string[];
	/** SSE 心跳的间隔（src/sse/sse.ts）。 */
	sseHeartbeatMs?: number;
	/** 按运行合并读取日志时一次请求最多扫描的字节数（src/logs/run-log-pages.ts）。 */
	logScanBytes?: number;
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
	presets,
	engine,
	packages,
	preflight,
	logs,
	actions,
	metrics,
	metricQueries,
	retention,
	artifacts,
	agentToken,
	publicConfig,
	sdkWheels,
	stdIndex,
	clientTarballs,
	agentBinaries,
	installScript,
	docs,
	feishuBots,
	feishu,
	webApp,
	corsOrigins,
	sseHeartbeatMs,
	logScanBytes,
}: HttpApiDeps): FastifyInstance {
	// 浏览器经同源的 /api/* 访问 API 与 SSE（ADR 0006），根路径上的 API 供 Agent、CLI 使用。
	const app = Fastify({ logger, rewriteUrl: (req) => stripApiPrefix(req.url ?? "/") });
	// app.close() 只在开始时关掉当时空闲的 keep-alive 连接。当时还没发完的响应（例如产物下载）发完后，连接留在
	// keep-alive 里，要等客户端或服务端的 keep-alive 超时（约 70 秒）才断开，app.close() 一直等它。
	// 关闭开始之后发完的响应随即关掉连接，和 Connection: close 的响应一样。
	let closing = false;
	app.addHook("preClose", (done) => {
		closing = true;
		done();
	});
	app.addHook("onResponse", (request, _reply, done) => {
		if (closing) request.raw.socket.destroySoon();
		done();
	});
	// 所有路由都按 @sfly/schema 的 HTTP 契约注册（ADR 0007）：不在契约里的路由、没注册的接口都让启动失败。
	guardHttpContract(app, httpContract);
	// 每个契约路由在进处理函数之前先过访问检查（ADR 0029「一处检查」）；装在注册任何契约路由之前。
	installAccessGuard(app, new AccessGuard({ store: new DbAccessStore(database.db), clock }));
	// 每个响应都带控制面时间，页面据此修正浏览器时间（ADR 0018）；SSE 另有心跳事件。
	// 在发出响应时取时间（不是收到请求时），处理耗时不算进页面的误差里。
	app.addHook("onSend", async (_request, reply) => {
		reply.header(CONTROL_PLANE_TIME_HEADER, clock.now().toISOString());
		reply.header(CONTROL_PLANE_VERSION_HEADER, publicConfig.version);
	});
	if (webApp) registerWebApp(app, webApp);
	registerCors(app, { origins: corsOrigins });
	// SSE 推送（docs/ARCHITECTURE.md：运行状态、日志），用法见 src/sse/sse.ts。
	const sse = registerSse(app, {
		clock,
		version: publicConfig.version,
		heartbeatMs: sseHeartbeatMs,
	});

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

	contractRoute(app, systemApi.health, async (_request, reply) => {
		const ok = await database.ping();
		const health = ok ? "ok" : "unavailable";
		return reply
			.code(ok ? 200 : 503)
			.send({ status: health, database: health, time: clock.now().toISOString() });
	});

	registerAgentRoutes(app, { hub, engine, orchestrations });
	registerDashboardRoutes(app, { db: database.db, clock, hub, queries: metricQueries });
	registerFeishuBotRoutes(app, { bots: feishuBots, client: feishu, db: database.db });
	registerOrchestrationRoutes(app, { db: database.db, orchestrations });
	registerPresetRoutes(app, { presets });
	registerRunRoutes(app, {
		db: database.db,
		hub,
		engine,
		orchestrations,
		presets,
		preflight,
		sse,
		progress: logs.progress,
		metrics: metrics.increments,
	});
	registerRunListRoutes(app, { db: database.db });
	registerRunFocusRoutes(app, { db: database.db, clock, queries: metricQueries });
	registerRunSummaryRoutes(app, { db: database.db, clock, queries: metricQueries, logs });
	registerLogRoutes(app, {
		logs,
		runLogs: new RunLogs({ db: database.db, logs, scanBytes: logScanBytes }),
		sse,
		isPurged: (runId) => retention.isPurged(runId),
	});
	registerMetricRoutes(app, { metrics, queries: metricQueries });
	registerActionRoutes(app, { actions, sse });
	registerArtifactRoutes(app, { artifacts, agentToken, publicHttpUrl: publicConfig.httpUrl });
	registerPackageRoutes(app, { packages, orchestrations });
	registerSdkRoutes(app, { wheels: sdkWheels, publicConfig, stdIndex });
	registerClientPackageRoutes(app, { tarballs: clientTarballs, publicConfig });
	registerAgentBinaryRoutes(app, { binaries: agentBinaries, installScript, publicConfig });
	registerDocsRoutes(app, {
		docs,
		values: () => ({ SFLY_URL: publicConfig.httpUrl(), SFLY_VERSION: publicConfig.version }),
	});

	return app;
}
