import { runFocusApi } from "@sfly/schema";
import type { FastifyInstance } from "fastify";
import { type RunFocusDeps, resolveRunFocus } from "../focus/run-focus.js";
import { contractRoute } from "./contract-route.js";
import { sendError } from "./errors.js";

/** 一次运行的关注项读数（契约见 @sfly/schema 的 runFocusApi，解析规则见 src/focus/run-focus.ts）。 */
export function registerRunFocusRoutes(app: FastifyInstance, deps: RunFocusDeps): void {
	contractRoute(
		app,
		runFocusApi.focus,
		async ({ params, query }, reply) =>
			(await resolveRunFocus(deps, params.id, { points: query.points })) ??
			sendError(reply, 404, "not_found", "run not found"),
	);
}
