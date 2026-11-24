import { CLIENT_HEADER } from "@sfly/schema";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Actor } from "../actor.js";
import { requireNickname } from "./nickname.js";

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
	if (nickname === undefined) return undefined;
	// 带了凭据的请求，身份是访问检查得出的（用户 ID、令牌的名称），昵称请求头不作数。
	const { access } = request;
	return {
		nickname,
		via: viaOf(request),
		userId: access?.userId ?? null,
		token: access?.tokenName ?? null,
		sessionId: access?.sessionId ?? null,
	};
}
