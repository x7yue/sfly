import {
	CONTROL_PLANE_TIME_HEADER,
	CONTROL_PLANE_VERSION_HEADER,
	httpContract,
	systemApi,
} from "@sfly/schema";
import Fastify, {
	type FastifyError,
	type FastifyInstance,
	type FastifyServerOptions,
} from "fastify";
import type { TaskActions } from "../actions/task-actions.js";
import type { AgentBinaries } from "../agent-binaries/agent-binaries.js";
import type { AgentCredentialService } from "../agents/agent-credentials.js";
import type { AgentHub } from "../agents/agent-hub.js";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import { AccessGuard } from "../auth/access-guard.js";
import { DbAccessStore } from "../auth/access-store.js";
import type { AccountService } from "../auth/accounts.js";
import type { OriginRules } from "../auth/cross-site.js";
import { PasswordGateAborted, PasswordGateBusy } from "../auth/password-gate.js";
import type { TokenService } from "../auth/tokens.js";
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
import type { SessionService } from "../sessions/session-service.js";
import type { SessionStore } from "../sessions/session-store.js";
import { registerSse } from "../sse/sse.js";
import { watchStreamCredentials } from "../sse/stream-recheck.js";
import { sanitizeLogArgs, serializeError } from "../util/safe-error.js";
import { installAccessGuard } from "./access.js";
import { registerAccountRoutes } from "./account-routes.js";
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
import { serializeRequest } from "./request-log.js";
import { registerRunFocusRoutes } from "./run-focus-routes.js";
import { registerRunListRoutes } from "./run-list-routes.js";
import { registerRunRoutes } from "./run-routes.js";
import { registerRunSummaryRoutes } from "./run-summary-routes.js";
import { registerSdkRoutes } from "./sdk-routes.js";
import { registerSessionRoutes } from "./session-routes.js";
import { registerTokenRoutes } from "./token-routes.js";
import { registerWebApp, stripApiPrefix, type WebApp } from "./web-app.js";

export interface HttpApiDeps {
	database: Database;
	clock: Clock;
	logger: boolean | { stream: NodeJS.WritableStream };
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
	/** 助手会话和它的事件（src/sessions/，ADR 0027）。 */
	sessions: SessionStore;
	/** 会话的写和助手此刻能不能用（src/sessions/session-service.ts）。 */
	sessionService: SessionService;
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
	/** 本地账号与登录（src/auth/accounts.ts）。 */
	accounts: AccountService;
	/** 个人令牌和项目令牌（src/auth/tokens.ts）。 */
	tokens: TokenService;
	/** Agent 凭据和开发 Agent（src/agents/agent-credentials.ts，#492）。 */
	agentCredentials: AgentCredentialService;
	/** 登录的空闲期限（毫秒）；默认 12 小时，要和 `accounts` 里的一致（下发和续期 Cookie 用它）。 */
	loginIdleMs?: number;
	/** 哪些来源算同源（登录 Cookie 的跨站检查，src/auth/cross-site.ts）。 */
	origins: OriginRules;
	/** 公开地址（`SFLY_PUBLIC_URL`）是 https：登录 Cookie 加 Secure。 */
	publicHttps: boolean;
	/** 控制面认的公开地址（`SFLY_PUBLIC_URL`，去掉末尾的斜杠），没有配置为 undefined：登录状态里带给页面。 */
	publicUrl?: string | undefined;
	/**
	 * 信任反向代理带来的 `X-Forwarded-For`（`SFLY_TRUST_PROXY`）：登录限速的「来源地址」取它的第一段。默认不信任：
	 * 它能被伪造，直连时随便写一个就能绕过按地址的限速；反向代理后面不开的话所有人是同一个来源地址。
	 */
	trustProxy?: FastifyServerOptions["trustProxy"];
	/** SSE 心跳的间隔（src/sse/sse.ts）。 */
	sseHeartbeatMs?: number;
	/** 打开着的事件流多久重新检查一次凭据（src/sse/stream-recheck.ts），默认 30 秒。 */
	streamRecheckMs?: number;
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
	sessions,
	sessionService,
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
	accounts,
	tokens,
	agentCredentials,
	loginIdleMs,
	origins,
	publicHttps,
	publicUrl,
	trustProxy,
	sseHeartbeatMs,
	streamRecheckMs,
	logScanBytes,
}: HttpApiDeps): FastifyInstance {
	// 浏览器经同源的 /api/* 访问 API 与 SSE（ADR 0006），根路径上的 API 供 Agent、CLI 使用。
	const app = Fastify({
		// 日志里的错误先去掉数据库查询的参数（src/util/safe-error.ts）：drizzle 的错误里带着参数，写 `users` 表出错时会带出密码哈希。
		logger:
			logger === false
				? false
				: {
						...(logger === true ? {} : logger),
						// 请求日志记的是完整地址：客户端写错、把令牌放进查询参数时，原值会进日志。长得像我们令牌的值（前缀加一串
						// 字母数字）在写进日志之前盖住（和任务日志、运行视图是同一条规则，{@link maskTokens}）；请求头不记。
						serializers: { err: serializeError, req: serializeRequest },
						hooks: {
							logMethod(args, method) {
								(method as (...parts: unknown[]) => void).apply(this, sanitizeLogArgs(args));
							},
						},
					},
		rewriteUrl: (req) => stripApiPrefix(req.url ?? "/"),
		trustProxy: trustProxy ?? false,
	});
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
	const accessStore = new DbAccessStore(database.db);
	// 每个契约路由在进处理函数之前先过访问检查（ADR 0029「一处检查」）；装在注册任何契约路由之前。
	installAccessGuard(app, new AccessGuard({ store: accessStore, clock, loginIdleMs, origins }), {
		publicHttps,
	});
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

	// 登录被注销、用户被停用、令牌被吊销时，关掉受影响的事件流（ADR 0029「SSE」）。
	const stopWatching = accounts.onRevoked((revocation) => {
		sse.closeWhere((stream) => {
			if (revocation.type === "token") return stream.tokenId === revocation.tokenId;
			if (stream.userId !== revocation.userId) return false;
			if (revocation.type === "user") return true;
			if (stream.loginId === null) return false;
			if (revocation.only !== undefined) return stream.loginId === revocation.only;
			return revocation.except === undefined || stream.loginId !== revocation.except;
		});
	});
	// 进程内收不到通知的失效（主机上的 reset-password 命令、直接改库、空闲期限到了）：打开着的流定期重新检查凭据。
	const stopRechecking = watchStreamCredentials({
		sse,
		store: accessStore,
		clock,
		intervalMs: streamRecheckMs,
		onError: (error) => app.log.error(serializeError(error), "重新检查打开着的事件流的凭据失败"),
	});
	app.addHook("preClose", (done) => {
		stopWatching();
		stopRechecking();
		done();
	});

	// Fastify 自身产生的错误（未知路由、请求体过大、JSON 解析失败等）也用统一的错误格式。
	app.setNotFoundHandler((request, reply) =>
		sendError(reply, 404, "not_found", `route ${request.method} ${request.url} not found`),
	);
	app.setErrorHandler((error: FastifyError, request, reply) => {
		// 同时验证密码的请求太多（src/auth/password-gate.ts）：没有去算哈希，让对方稍后再试。
		if (error instanceof PasswordGateBusy) {
			reply.header("retry-after", Math.max(1, Math.ceil(error.retryAfterMs / 1000)));
			return sendError(reply, 503, "server_busy", error.message);
		}
		// 客户端在排队等着验证密码时断开了（src/auth/password-gate.ts）：没有去验证，响应也没人收，不是错误，不写错误日志。
		if (error instanceof PasswordGateAborted) return reply.code(499).send();
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

	registerAccountRoutes(app, { accounts, publicHttps, publicUrl });
	registerTokenRoutes(app, { tokens, accounts });
	registerAgentRoutes(app, {
		hub,
		engine,
		orchestrations,
		credentials: agentCredentials,
		accounts,
	});
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
	registerSessionRoutes(app, { sessions, service: sessionService, sse });
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
