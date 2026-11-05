import { presenceApi } from "@sfly/schema";
import type { FastifyInstance } from "fastify";
import type { OrchestrationStore } from "../orchestrations/orchestration-store.js";
import type { PresenceRegistry } from "../presence/presence-registry.js";
import type { Sse } from "../sse/sse.js";
import { isUuid } from "../util/uuid.js";
import { contractRoute, contractStream } from "./contract-route.js";
import { sendError } from "./errors.js";
import { requireNickname } from "./nickname.js";

/**
 * 在线编辑者（契约见 @sfly/schema 的 presenceApi）：编辑页面每 10 秒 `POST /orchestrations/:id/presence`
 * 一次心跳，通过 SSE `GET /orchestrations/:id/presence/events` 接收名单（事件 `editors`）；
 * 关闭页面时 `POST /orchestrations/:id/presence/leave` 主动离开（否则 30 秒无心跳后移除）。
 */
export function registerPresenceRoutes(
	app: FastifyInstance,
	deps: { orchestrations: OrchestrationStore; presence: PresenceRegistry; sse: Sse },
): void {
	const { orchestrations, presence, sse } = deps;
	const exists = async (id: string) => isUuid(id) && (await orchestrations.get(id)) !== undefined;

	contractRoute(app, presenceApi.heartbeat, async ({ params, body }, reply, raw) => {
		const nickname = requireNickname(raw, reply);
		if (!nickname) return reply;
		if (!(await exists(params.id)))
			return sendError(reply, 404, "not_found", "orchestration not found");
		return { editors: presence.heartbeat(params.id, body.session_id, nickname) };
	});

	// 关闭页面时浏览器用 keepalive 请求主动离开（不要求昵称：只移除这个随机会话 ID 自己）。
	contractRoute(app, presenceApi.leave, async ({ params, body }, reply) => {
		if (isUuid(params.id)) presence.leave(params.id, body.session_id);
		return reply.code(204).send();
	});

	contractStream(app, sse, presenceApi.events, async ({ params: { id } }, open, reply) => {
		if (!(await exists(id))) return sendError(reply, 404, "not_found", "orchestration not found");
		open((stream) => {
			stream.send("editors", { orchestration_id: id, editors: presence.editors(id) });
			return presence.subscribe(id, (data) => stream.send("editors", data));
		});
		return undefined;
	});
}
