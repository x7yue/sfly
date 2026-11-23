import { hasUnsafeNameCharacter, NICKNAME_HEADER } from "@sfly/schema";
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
 * 路由应直接 `return reply`。带了凭据的请求不看昵称请求头：身份是访问检查得出的（用户的显示名，项目令牌的名称）。
 */
export function requireNickname(request: FastifyRequest, reply: FastifyReply): string | undefined {
	if (request.access) return request.access.name;
	const nickname = nicknameOf(request);
	if (!nickname) {
		sendError(reply, 400, "nickname_required", `${NICKNAME_HEADER} header is required`);
		return undefined;
	}
	// 昵称会被写进数据库（jsonb 拒收 NUL）：挡在任何写之前，不让它在改了状态之后才失败。
	if (nickname.includes("\u0000")) {
		sendError(reply, 400, "invalid_request", "昵称里不能含 NUL 字符（\\u0000）");
		return undefined;
	}
	// 昵称会记成作者、触发人，出现在「经 …」和命令行的输出里：控制字符和看不见的格式字符（零宽字符、双向文字的控制字符）
	// 会把终端弄乱、让看起来一样的名字不一样。
	if (hasUnsafeNameCharacter(nickname)) {
		sendError(
			reply,
			400,
			"invalid_request",
			"昵称里不能有控制字符（换行、转义序列等）和看不见的格式字符（零宽字符、双向文字的控制字符）",
		);
		return undefined;
	}
	return nickname;
}
