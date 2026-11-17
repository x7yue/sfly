import { actionsApi } from "@sfly/schema";
import type { FastifyInstance } from "fastify";
import { decodeActionCursor } from "../actions/action-details.js";
import type { TaskActions } from "../actions/task-actions.js";
import type { Sse } from "../sse/sse.js";
import { contractRoute, contractStream } from "./contract-route.js";
import { sendError } from "./errors.js";

/**
 * 任务的动作（契约见 @sfly/schema 的 actionsApi）：动作摘要、明细分页（游标不是之前返回的 `before` 时 400
 * `invalid_request`）和实时推送（`after` 与 `Last-Event-ID` 取较大者，见 TaskActions.follow）。
 */
export function registerActionRoutes(
	app: FastifyInstance,
	deps: { actions: TaskActions; sse: Sse },
): void {
	contractRoute(app, actionsApi.summary, async ({ params }, reply) => {
		const summary = await deps.actions.summary(params.id);
		return summary ?? sendError(reply, 404, "not_found", "task not found");
	});

	contractRoute(app, actionsApi.page, async ({ params, query }, reply) => {
		const before = query.before === undefined ? undefined : decodeActionCursor(query.before);
		if (query.before !== undefined && !before) {
			return sendError(reply, 400, "invalid_request", "游标不是之前返回的 before");
		}
		const page = await deps.actions.page(params.id, { ...query, before });
		return page ?? sendError(reply, 404, "not_found", "task not found");
	});

	contractStream(
		app,
		deps.sse,
		actionsApi.events,
		async ({ params, query }, open, reply, request) => {
			const taskId = params.id;
			const runId = await deps.actions.runOf(taskId);
			if (!runId) return sendError(reply, 404, "not_found", "task not found");
			open((stream) => {
				const resume = Number(stream.lastEventId);
				const after = Math.max(
					query.after ?? 0,
					Number.isSafeInteger(resume) && resume > 0 ? resume : 0,
				);
				return deps.actions.follow(
					{ taskId, runId },
					after,
					(event) => {
						if (event.kind === "summary") stream.send("summary", event.summary, event.rev);
						else stream.send("actions", { actions: event.actions }, event.rev);
					},
					(error) => {
						request.log.error(error);
						stream.close();
					},
				);
			});
			return undefined;
		},
	);
}
