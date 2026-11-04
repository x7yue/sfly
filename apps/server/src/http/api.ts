import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { AgentHub } from "../agents/agent-hub.js";
import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import type { Engine } from "../engine/engine.js";
import type { TaskLogs } from "../logs/task-logs.js";
import type { OrchestrationStore } from "../orchestrations/orchestration-store.js";
import type { PackageRepository } from "../packages/package-repository.js";
import type { PresenceRegistry } from "../presence/presence-registry.js";
import type { Preflight } from "../runs/preflight.js";
import { registerSse } from "../sse/sse.js";
import { sendError } from "./errors.js";
import { registerLogRoutes } from "./log-routes.js";
import { registerOrchestrationRoutes } from "./orchestration-routes.js";
import { registerPackageRoutes } from "./packages-routes.js";
import { registerPresenceRoutes } from "./presence-routes.js";
import { registerRunRoutes } from "./run-routes.js";

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
}: HttpApiDeps): FastifyInstance {
	const app = Fastify({ logger });
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
	});
	registerLogRoutes(app, { logs, sse });
	registerPackageRoutes(app, packages);
	registerPresenceRoutes(app, { orchestrations, presence, sse });

	return app;
}
