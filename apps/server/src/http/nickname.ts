import { NICKNAME_HEADER } from "@sfly/schema";
import type { FastifyReply, FastifyRequest } from "fastify";
import { sendError } from "./errors.js";

/** 读取请求里的昵称；没有或为空时返回 undefined。 */
export function nicknameOf(request: FastifyRequest): string | undefined {
	const raw = request.headers[NICKNAME_HEADER];
	if (typeof raw !== "string") return undefined;
	let nickname: string;
	try {
		nickname = decodeURIComponent(raw).trim();
	} catch {
		nickname = raw.trim();
	}
	return nickname === "" ? undefined : nickname;
}

/**
 * 写操作的昵称守卫：返回昵称；没有昵称时已回复 400 `nickname_required`，返回 undefined，
 * 路由应直接 `return reply`。
 */
export function requireNickname(request: FastifyRequest, reply: FastifyReply): string | undefined {
	const nickname = nicknameOf(request);
	if (!nickname)
		sendError(reply, 400, "nickname_required", `${NICKNAME_HEADER} header is required`);
	return nickname;
}
