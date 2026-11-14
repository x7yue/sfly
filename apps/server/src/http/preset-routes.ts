import { presetsApi } from "@sfly/schema";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { PresetIssue } from "../presets/preset-input.js";
import type { PresetStore } from "../presets/preset-store.js";
import { isUuid } from "../util/uuid.js";
import { requireActor } from "./actor.js";
import { contractRoute } from "./contract-route.js";
import { sendError } from "./errors.js";
import { requireNickname } from "./nickname.js";

const notFound = (reply: FastifyReply) =>
	sendError(reply, 404, "not_found", "orchestration not found");

const presetNotFound = (reply: FastifyReply) =>
	sendError(reply, 404, "preset_not_found", "这个场景没有这个运行预设");

const invalidPreset = (reply: FastifyReply, issues: PresetIssue[]) =>
	sendError(
		reply,
		400,
		"invalid_preset",
		`运行预设不符合要求：${issues.map((i) => i.message).join("；")}`,
		issues,
	);

const nameTaken = (reply: FastifyReply, name: string) =>
	sendError(
		reply,
		409,
		"preset_name_taken",
		`这个场景已经有名为「${name}」的运行预设，名称不能重复`,
	);

/**
 * 运行预设（契约见 @sfly/schema 的 presetsApi，ADR 0023）：列出、新建、修改、复制、删除。
 * 写操作需要昵称，昵称记为最后修改人；场景归档期间也能写。预设是场景的设置，不产生新的场景版本。
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
				return invalidPreset(reply, result.issues);
			case "name_taken":
				return nameTaken(reply, body.name);
			case "created":
				return reply.code(201).send(result.preset);
		}
	});
	contractRoute(app, presetsApi.update, async ({ params, body }, reply, raw) => {
		const actor = requireActor(raw, reply);
		if (!actor) return reply;
		if (!isUuid(params.id) || !isUuid(params.presetId)) return presetNotFound(reply);
		const result = await presets.update(params.id, params.presetId, body, actor);
		switch (result.kind) {
			case "not_found":
				return presetNotFound(reply);
			case "invalid":
				return invalidPreset(reply, result.issues);
			case "name_taken":
				return nameTaken(reply, body.name ?? "");
			case "updated":
				return result.preset;
		}
	});

	contractRoute(app, presetsApi.copy, async ({ params, body }, reply, raw) => {
		const actor = requireActor(raw, reply);
		if (!actor) return reply;
		if (!isUuid(params.id) || !isUuid(params.presetId)) return presetNotFound(reply);
		const result = await presets.copy(params.id, params.presetId, body.name, actor);
		switch (result.kind) {
			case "not_found":
				return presetNotFound(reply);
			case "invalid":
				return invalidPreset(reply, result.issues);
			case "name_taken":
				return nameTaken(reply, body.name);
			case "copied":
				return reply.code(201).send(result.preset);
		}
	});

	contractRoute(app, presetsApi.remove, async ({ params }, reply, raw) => {
		if (!requireNickname(raw, reply)) return reply;
		const removed =
			isUuid(params.id) && isUuid(params.presetId)
				? await presets.remove(params.id, params.presetId)
				: false;
		return removed ? reply.code(204).send() : presetNotFound(reply);
	});
}
