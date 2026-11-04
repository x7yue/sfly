import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/database.js";
import type { Engine } from "../engine/engine.js";
import { getRunView } from "../engine/run-queries.js";
import { isUuid, sendError } from "./errors.js";
import { nicknameOf } from "./nickname.js";

const TriggerBody = z.strictObject({ params: z.record(z.string(), z.unknown()).default({}) });

/** 运行：手动触发编排的最新版本、查询运行状态。 */
export function registerRunRoutes(app: FastifyInstance, deps: { db: Db; engine: Engine }): void {
	app.post<{ Params: { id: string } }>("/orchestrations/:id/runs", async (request, reply) => {
		const triggeredBy = nicknameOf(request);
		if (!triggeredBy) {
			return sendError(reply, 400, "nickname_required", "x-sfly-nickname header is required");
		}
		const body = TriggerBody.safeParse(request.body ?? {});
		if (!body.success) {
			return sendError(
				reply,
				400,
				"invalid_request",
				"params must be an object",
				z.treeifyError(body.error),
			);
		}
		if (!isUuid(request.params.id))
			return sendError(reply, 404, "not_found", "orchestration not found");
		const outcome = await deps.engine.trigger(request.params.id, body.data.params, triggeredBy);
		if (!outcome.ok) {
			return sendError(reply, outcome.status, outcome.code, outcome.message, outcome.details);
		}
		const run = await getRunView(deps.db, outcome.runId);
		return reply.code(201).send(run);
	});

	app.get<{ Params: { id: string } }>("/runs/:id", async (request, reply) => {
		const run = isUuid(request.params.id)
			? await getRunView(deps.db, request.params.id)
			: undefined;
		if (!run) return sendError(reply, 404, "not_found", "run not found");
		return run;
	});
}
