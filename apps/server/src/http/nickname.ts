import type { FastifyRequest } from "fastify";

/**
 * 浏览器昵称请求头（ADR 0004：只用于显示，不做鉴权）。
 * 值按 encodeURIComponent 编码，这样中文昵称也能放进请求头。
 */
export const NICKNAME_HEADER = "x-sfly-nickname";

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
