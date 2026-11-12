import type { FastifyReply, FastifyRequest } from "fastify";
import type { Actor } from "../actor.js";
import { requireNickname } from "./nickname.js";

/**
 * 客户端标识请求头：`sfly-cli/<版本> agent/<AI 编程助手名称>`，`agent/` 部分只在命令行
 * 检测到自己运行在 AI 编程助手里时才有。和昵称一样不做校验，只用于标注。
 */
export const CLIENT_HEADER = "x-sfly-client";

const AGENT_PREFIX = "agent/";

/** 请求头里 `agent/<名称>` 的名称；没有请求头、没有 `agent/` 部分或名称为空时返回 null。 */
export function viaOf(request: FastifyRequest): string | null {
	const raw = request.headers[CLIENT_HEADER];
	if (typeof raw !== "string") return null;
	for (const token of raw.split(/[\s,]+/)) {
		if (!token.startsWith(AGENT_PREFIX)) continue;
		const name = token.slice(AGENT_PREFIX.length);
		if (name !== "") return name;
	}
	return null;
}

/** 写操作的发起人守卫：没有昵称时已回复 400 `nickname_required`，返回 undefined，路由应直接 `return reply`。 */
export function requireActor(request: FastifyRequest, reply: FastifyReply): Actor | undefined {
	const nickname = requireNickname(request, reply);
	return nickname === undefined ? undefined : { nickname, via: viaOf(request) };
}
