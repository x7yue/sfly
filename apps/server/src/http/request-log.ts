import type { FastifyRequest } from "fastify";
import { maskTokens } from "../logs/secrets.js";

/**
 * 请求日志里 `req` 的样子（Fastify 默认的那几个字段：方法、地址、主机、来源），地址里长得像我们令牌的值先盖住。
 * 请求日志记的是完整地址：客户端写错、把令牌放进查询参数（`?token=sfly_pat_…`）时，原值会进日志；盖住用的是任务日志、
 * 运行视图那条规则（`maskTokens`，按前缀认），不另写一套。请求头一个都不记（`Authorization`、`Cookie` 不进日志）。
 */
export function serializeRequest(request: FastifyRequest) {
	return {
		method: request.method,
		url: maskTokens(request.url),
		host: request.host,
		remoteAddress: request.ip,
		remotePort: request.socket?.remotePort,
	};
}
