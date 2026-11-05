import { timingSafeEqual } from "node:crypto";

/**
 * Agent 共享注册令牌的校验（Hello.token、上传产物的 `Authorization: Bearer <token>`）。
 * 控制面没有配置令牌（undefined 或空串）时不校验；否则用定长时间比较。
 */
export function agentTokenMatches(expected: string | undefined, presented: string | undefined) {
	if (!expected) return true;
	const a = Buffer.from(presented ?? "");
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

/** 上传请求的 Authorization 头里的令牌（`Bearer <token>`）；格式不对时为 undefined。 */
export function bearerToken(header: string | undefined): string | undefined {
	const match = /^Bearer (.*)$/.exec(header ?? "");
	return match?.[1];
}
