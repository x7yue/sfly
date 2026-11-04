import Fastify, { type FastifyInstance } from "fastify";
import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";

export interface HttpApiDeps {
	database: Database;
	clock: Clock;
	logger: boolean;
}

/** HTTP API（Fastify，HTTP/1.1）。路由按模块注册在这里。 */
export function buildHttpApi({ database, clock, logger }: HttpApiDeps): FastifyInstance {
	const app = Fastify({ logger });

	app.get("/health", async (_req, reply) => {
		const ok = await database.ping();
		return reply.code(ok ? 200 : 503).send({
			status: ok ? "ok" : "unavailable",
			database: ok ? "ok" : "unavailable",
			time: clock.now().toISOString(),
		});
	});

	return app;
}
