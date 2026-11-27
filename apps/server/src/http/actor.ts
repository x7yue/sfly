import { CLIENT_HEADER, VIA_NAME_PATTERN, VIA_UNKNOWN } from "@sfly/schema";
import type { FastifyRequest } from "fastify";
import type { Actor } from "../actor.js";

const AGENT_PREFIX = "agent/";

/**
 * 请求头里 `agent/<名称>` 的名称；没有请求头、没有 `agent/` 部分、名称为空时返回 null。这是客户端自己报的标注，
 * 存下来之后会显示在别人的命令行和控制台里：名称只收字母、数字和 `. _ + -`、最多 64 个字符（{@link VIA_NAME_PATTERN}）；
 * 有 `agent/` 但名称都不合格时存固定的占位值 {@link VIA_UNKNOWN}（显示成「未知」，和库里旧的不合格值一样），不让请求失败；
 * 有一个合格的就用它。
 */
export function viaOf(request: FastifyRequest): string | null {
	const raw = request.headers[CLIENT_HEADER];
	if (typeof raw !== "string") return null;
	let invalid = false;
	for (const token of raw.split(/[\s,]+/)) {
		if (!token.startsWith(AGENT_PREFIX)) continue;
		const name = token.slice(AGENT_PREFIX.length);
		if (VIA_NAME_PATTERN.test(name)) return name;
		if (name !== "") invalid = true;
	}
	return invalid ? VIA_UNKNOWN : null;
}

/**
 * 写操作的发起人：访问检查得出的身份（用户的显示名和 ID，项目令牌的名称，会话令牌的会话）。不带凭据的请求在访问检查那一步
 * 就是 401（#494），走到处理函数的写请求都带着凭据；没有时是接口的声明错了（比如写接口被声明成不看凭据），当作程序错误。
 */
export function actorOf(request: FastifyRequest): Actor {
	const { access } = request;
	if (!access) throw new Error(`${request.method} ${request.url}：写操作没有经过访问检查得出身份`);
	return {
		name: access.name,
		via: viaOf(request),
		userId: access.userId ?? null,
		token: access.tokenName ?? null,
		sessionId: access.sessionId ?? null,
	};
}
