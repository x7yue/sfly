import { describeNameProblem, NICKNAME_HEADER, nameProblem } from "@sfly/schema";
import type { FastifyReply, FastifyRequest } from "fastify";
import { sendError } from "./errors.js";

/** 昵称请求头里读出来的值：去了首尾空白的昵称，和请求头的值是不是按 encodeURIComponent 编码过的（解码成功、值变了）。 */
function readNickname(request: FastifyRequest): { nickname: string; encoded: boolean } | undefined {
	const raw = request.headers[NICKNAME_HEADER];
	if (typeof raw !== "string") return undefined;
	let nickname: string;
	let encoded = false;
	try {
		const decoded = decodeURIComponent(raw);
		encoded = decoded !== raw;
		nickname = decoded.trim();
	} catch {
		// 解码不了（不合法的 %）：没有按契约编码，原样用。
		nickname = raw.trim();
	}
	return nickname === "" ? undefined : { nickname, encoded };
}

/** 读取请求里的昵称；没有或为空时返回 undefined。 */
export function nicknameOf(request: FastifyRequest): string | undefined {
	return readNickname(request)?.nickname;
}

/**
 * 昵称请求头的值要按 encodeURIComponent 编码（契约）。直接写 UTF-8 的调用方，中文、日文、韩文的字节被读成 U+0080–U+00FF 的字符，
 * 其中的 U+0080–U+009F 是控制字符、U+00AD 是软连字符，被表拒绝：这时才提示要编码，不然看不出为什么「普通的名字」被拒绝。
 * 不提示的：按契约编码过的请求（问题在字符本身，说字符的事）；ASCII 的字符（直接写的制表符，编码了一样被拒）。
 */
const UNENCODED_HINT = `；请求头 ${NICKNAME_HEADER} 的值要按 encodeURIComponent 编码（直接写 UTF-8 的中文、日文、韩文，字节会被读成控制字符）`;

/**
 * 写操作的昵称守卫：返回昵称；没有昵称时已回复 400 `nickname_required`，返回 undefined，
 * 路由应直接 `return reply`。带了凭据的请求不看昵称请求头：身份是访问检查得出的（用户的显示名，项目令牌的名称）。
 */
export function requireNickname(request: FastifyRequest, reply: FastifyReply): string | undefined {
	if (request.access) return request.access.name;
	const read = readNickname(request);
	if (read === undefined) {
		sendError(reply, 400, "nickname_required", `${NICKNAME_HEADER} header is required`);
		return undefined;
	}
	const { nickname, encoded } = read;
	// 昵称会记成作者、触发人，出现在「经 …」和命令行的输出里：用和令牌名称、显示名同一个函数（`text-safety.ts`，NUL 也在里面：
	// 数据库的 jsonb 拒收它，挡在任何写之前，不让它在改了状态之后才失败），不比它更严。
	const problem = nameProblem(nickname);
	if (problem !== undefined) {
		sendError(
			reply,
			400,
			"invalid_request",
			describeNameProblem("昵称", problem) +
				(!encoded && problem.kind !== "no_visible" && problem.codePoint >= 0x80
					? UNENCODED_HINT
					: ""),
		);
		return undefined;
	}
	return nickname;
}
