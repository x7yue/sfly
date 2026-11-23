import { hasUnsafeNameCharacter, NICKNAME_HEADER, unsafeNameMessage } from "@sfly/schema";
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
	// 昵称会记成作者、触发人，出现在「经 …」和命令行的输出里：用和令牌名称、显示名同一张表（`text-safety.ts`），不比它更严。
	// 请求头的值要按 encodeURIComponent 编码（契约）：直接写 UTF-8 的调用方，中文、日文、韩文的字节被读成 U+0080–U+009F
	// 的控制字符，报错要说明原因，不然看不出为什么「普通的名字」被拒绝。
	if (hasUnsafeNameCharacter(nickname)) {
		sendError(
			reply,
			400,
			"invalid_request",
			`${unsafeNameMessage("昵称")}；请求头 ${NICKNAME_HEADER} 的值要按 encodeURIComponent 编码（直接写 UTF-8 的中文、日文、韩文会被读成控制字符）`,
		);
		return undefined;
	}
	return nickname;
}
