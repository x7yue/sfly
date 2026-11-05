import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { OrchestrationStore } from "../orchestrations/orchestration-store.js";
import type { PresenceRegistry } from "../presence/presence-registry.js";
import type { Sse } from "../sse/sse.js";
import { isUuid } from "../util/uuid.js";
import { sendError } from "./errors.js";
import { requireNickname } from "./nickname.js";

const HeartbeatBody = z.object({ session_id: z.string().trim().min(1).max(200) });

/**
 * 在线编辑者：编辑页面每 10 秒 `POST /orchestrations/:id/presence` 一次心跳，
 * 通过 SSE `GET /orchestrations/:id/presence/events` 接收名单（事件 `editors`）。
 */
export function registerPresenceRoutes(
	app: FastifyInstance,
	deps: { orchestrations: OrchestrationStore; presence: PresenceRegistry; sse: Sse },
): void {
	const { orchestrations, presence, sse } = deps;
	const exists = async (id: string) => isUuid(id) && (await orchestrations.get(id)) !== undefined;

	app.post<{ Params: { id: string } }>("/orchestrations/:id/presence", async (request, reply) => {
		const nickname = requireNickname(request, reply);
		if (!nickname) return reply;
		const body = HeartbeatBody.safeParse(request.body);
		if (!body.success) {
			return sendError(
				reply,
				400,
				"invalid_request",
				"session_id is required",
				z.treeifyError(body.error),
			);
		}
		if (!(await exists(request.params.id)))
			return sendError(reply, 404, "not_found", "orchestration not found");
		return { editors: presence.heartbeat(request.params.id, body.data.session_id, nickname) };
	});

	app.get<{ Params: { id: string } }>(
		"/orchestrations/:id/presence/events",
		async (request, reply) => {
			const id = request.params.id;
			if (!(await exists(id))) return sendError(reply, 404, "not_found", "orchestration not found");
			sse.open(request, reply, (stream) => {
				stream.send({
					event: "editors",
					data: { orchestration_id: id, editors: presence.editors(id) },
				});
				return presence.subscribe(id, (data) => stream.send({ event: "editors", data }));
			});
		},
	);
}
