import { actionsApi } from "@sfly/schema";
import type { FastifyInstance } from "fastify";
import type { TaskActions } from "../actions/task-actions.js";
import { contractRoute } from "./contract-route.js";
import { sendError } from "./errors.js";

/** 任务的动作（契约见 @sfly/schema 的 actionsApi）：动作摘要。 */
export function registerActionRoutes(app: FastifyInstance, deps: { actions: TaskActions }): void {
	contractRoute(app, actionsApi.summary, async ({ params }, reply) => {
		const summary = await deps.actions.summary(params.id);
		return summary ?? sendError(reply, 404, "not_found", "task not found");
	});
}
