import { presetsApi } from "@sfly/schema";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { PresetStore } from "../presets/preset-store.js";
import { isUuid } from "../util/uuid.js";
import { requireActor } from "./actor.js";
import { contractRoute } from "./contract-route.js";
import { sendError } from "./errors.js";

const notFound = (reply: FastifyReply) =>
	sendError(reply, 404, "not_found", "orchestration not found");

/**
 * 运行预设（契约见 @sfly/schema 的 presetsApi，ADR 0023）：列出、新建。写操作需要昵称，昵称记为最后修改人。
 * 预设是场景的设置，不产生新的场景版本。
 */
export function registerPresetRoutes(
	app: FastifyInstance,
	{ presets }: { presets: PresetStore },
): void {
	contractRoute(app, presetsApi.list, async ({ params }, reply) => {
		const list = isUuid(params.id) ? await presets.list(params.id) : undefined;
		return list ? { presets: list } : notFound(reply);
	});

	contractRoute(app, presetsApi.create, async ({ params, body }, reply, raw) => {
		const actor = requireActor(raw, reply);
		if (!actor) return reply;
		if (!isUuid(params.id)) return notFound(reply);
		const result = await presets.create(params.id, body, actor);
		switch (result.kind) {
			case "not_found":
				return notFound(reply);
			case "invalid":
				return sendError(
					reply,
					400,
					"invalid_preset",
					`运行预设不符合要求：${result.issues.map((i) => i.message).join("；")}`,
					result.issues,
				);
			case "name_taken":
				return sendError(
					reply,
					409,
					"preset_name_taken",
					`这个场景已经有名为「${body.name}」的运行预设，名称不能重复`,
				);
			case "created":
				return reply.code(201).send(result.preset);
		}
	});
}
