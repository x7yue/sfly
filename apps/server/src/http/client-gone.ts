import type { FastifyReply } from "fastify";

/**
 * 客户端在响应发完之前断开连接时中止的信号（排队等着算密码哈希的请求用，见 ../auth/password-gate.ts）。
 *
 * 不用 Fastify 的 `request.signal`：它挂在请求对象的 `close` 上，Node 里请求体读完就触发，正常的请求也会中止。
 * 这里看响应对象的 `close`：响应已经写完（`writableFinished`）之后的 `close` 是正常收尾，没写完就 `close` 才是客户端断开了。
 */
export function clientGone(reply: FastifyReply): AbortSignal {
	const controller = new AbortController();
	reply.raw.once("close", () => {
		if (!reply.raw.writableFinished) controller.abort();
	});
	return controller.signal;
}
