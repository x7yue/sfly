import { runFocusApi } from "@sfly/schema";
import type { FastifyInstance } from "fastify";
import { type RunFocusDeps, resolveRunFocus } from "../focus/run-focus.js";
import { readRuns } from "../runs/run-read.js";
import { contractRoute } from "./contract-route.js";
import { sendError } from "./errors.js";

/** 一次运行的关注项读数（契约见 @sfly/schema 的 runFocusApi，解析规则见 src/focus/run-focus.ts）。 */
export function registerRunFocusRoutes(app: FastifyInstance, deps: RunFocusDeps): void {
	contractRoute(app, runFocusApi.focus, async ({ params, query }, reply) => {
		const read = (await readRuns(deps.db, [params.id], "full")).get(params.id);
		if (!read) return sendError(reply, 404, "not_found", "run not found");
		return resolveRunFocus(deps, read, { points: query.points });
	});
}
