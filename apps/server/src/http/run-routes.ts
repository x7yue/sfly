import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/database.js";
import type { Engine } from "../engine/engine.js";
import { getRunView, listRuns } from "../engine/run-queries.js";
import type { OrchestrationStore } from "../orchestrations/orchestration-store.js";
import type { Preflight } from "../runs/preflight.js";
import type { Sse } from "../sse/sse.js";
import { isUuid, sendError } from "./errors.js";
import { nicknameOf } from "./nickname.js";

const TriggerBody = z.strictObject({ params: z.record(z.string(), z.unknown()).default({}) });

/** 运行：触发前预检、手动触发编排的最新版本、运行列表、查询运行状态。 */
export function registerRunRoutes(
	app: FastifyInstance,
	deps: {
		db: Db;
		engine: Engine;
		orchestrations: OrchestrationStore;
		preflight: Preflight;
		sse: Sse;
	},
): void {
	// 触发表单和预检结果：最新版本号、入口参数声明、不能触发的原因（空表示可以触发）。
	app.get<{ Params: { id: string } }>("/orchestrations/:id/preflight", async (request, reply) => {
		const head = isUuid(request.params.id)
			? await deps.orchestrations.head(request.params.id)
			: undefined;
		if (!head) return sendError(reply, 404, "not_found", "orchestration not found");
		if (head.number === 0) {
			return {
				version: 0,
				params: [],
				problems: [{ code: "no_version", message: "编排还没有保存过版本" }],
			};
		}
		const entry = head.document.nodes.find((n) => n.kind === "entry");
		return {
			version: head.number,
			params: entry?.kind === "entry" ? entry.params : [],
			problems: await deps.preflight(head.document),
		};
	});

	app.get<{ Params: { id: string } }>("/orchestrations/:id/runs", async (request, reply) => {
		const found = isUuid(request.params.id)
			? await deps.orchestrations.get(request.params.id)
			: undefined;
		if (!found) return sendError(reply, 404, "not_found", "orchestration not found");
		return { runs: await listRuns(deps.db, found.id) };
	});

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

	// 运行状态的实时推送：连上时先发一条完整的运行视图，之后运行或任何节点的状态变化时再发一条（事件 run）。
	app.get<{ Params: { id: string } }>("/runs/:id/events", async (request, reply) => {
		const runId = request.params.id;
		if (!isUuid(runId) || !(await getRunView(deps.db, runId))) {
			return sendError(reply, 404, "not_found", "run not found");
		}
		deps.sse.open(request, reply, (stream) => {
			// 每条流同时只查询一次；查询期间又有变化时，查完再查一次（合并成最新状态）。
			let querying = false;
			let again = false;
			const push = async () => {
				if (querying) {
					again = true;
					return;
				}
				querying = true;
				try {
					do {
						again = false;
						const view = await getRunView(deps.db, runId);
						if (view) stream.send({ event: "run", data: view });
					} while (again && !stream.closed);
				} catch (error) {
					request.log.error(error);
				} finally {
					querying = false;
				}
			};
			const unsubscribe = deps.engine.runChanges.subscribe(runId, () => void push());
			void push();
			return unsubscribe;
		});
	});

	app.get<{ Params: { id: string } }>("/runs/:id", async (request, reply) => {
		const run = isUuid(request.params.id)
			? await getRunView(deps.db, request.params.id)
			: undefined;
		if (!run) return sendError(reply, 404, "not_found", "run not found");
		return run;
	});
}
