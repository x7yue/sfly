import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo, Socket } from "node:net";

/**
 * 假的飞书 Webhook 服务（ADR 0020）：在本机随机端口起一个 HTTP 服务，记录收到的每个请求，
 * 可以为每个请求指定返回的 HTTP 状态码和 `code`，也可以让它不响应。写法参照 pypi-stub.ts、release-mirror.ts。
 *
 * 飞书机器人的 Webhook 地址直接指向它（{@link FakeFeishu.webhookUrl}），生产代码不为测试留任何注入点。
 * 同一个服务也能当 HTTP 代理用：请求以绝对地址到达时记 `viaProxy`，CONNECT 隧道请求记进 `connects` 后回 502。
 */
export interface FeishuReply {
	/** HTTP 状态码，默认 200。 */
	status?: number;
	/** 响应体里的 `code`，默认 0（成功）。 */
	code?: number;
	/** 响应体里的 `msg`，默认 code 为 0 时是 success，否则是 error。 */
	msg?: string;
	/** 原样作为响应体（模拟不是 JSON 的响应）；给了就忽略 code 和 msg。 */
	body?: string;
	/** 不响应：请求收到后连接一直保持打开，直到服务关闭。 */
	hang?: true;
	/** 收到请求后等这么久（真实时间，毫秒）再响应：用来观察同一时刻有几个请求在途（{@link FakeFeishu.maxInFlight}）。 */
	delayMs?: number;
}

export interface FeishuRequest {
	method: string;
	/** Webhook 地址里的路径（请求经代理以绝对地址到达时，是绝对地址里的路径）。 */
	path: string;
	headers: IncomingHttpHeaders;
	/** 请求体原文。 */
	body: string;
	/** 请求体解析成 JSON；不是 JSON 时为 undefined。 */
	json: unknown;
	/** 请求以绝对地址到达（HTTP 代理的请求形式），即经过了作为代理使用的这个服务。 */
	viaProxy: boolean;
}

export interface FakeFeishu {
	/** `http://127.0.0.1:<端口>`。 */
	readonly origin: string;
	/** 指向这个服务的 Webhook 地址；不同 token 是不同的地址。 */
	webhookUrl(token?: string): string;
	/** 收到的请求，按到达顺序。 */
	readonly requests: readonly FeishuRequest[];
	/** 同一时刻在途请求（收到之后、响应结束之前）的最大数量；不响应的请求一直算在途。 */
	readonly maxInFlight: number;
	/** 作为 HTTPS 代理收到的 CONNECT 请求的目标（`主机:端口`），按到达顺序。 */
	readonly connects: readonly string[];
	/** 排好后面请求的应答：按到达顺序一个请求用掉一个，用完后用 {@link replyAlways} 的应答（默认 200、code 0）。 */
	reply(...replies: FeishuReply[]): void;
	/** 只给 Webhook 地址 `webhookUrl(token)` 排好后面请求的应答（优先于 {@link reply}）：多个机器人同时投递时，到达的先后不确定。 */
	replyTo(token: string, ...replies: FeishuReply[]): void;
	/** 排好的应答用完后的默认应答。 */
	replyAlways(reply: FeishuReply): void;
	close(): Promise<void>;
}

const ok: FeishuReply = { status: 200, code: 0 };

function responseBody(reply: FeishuReply): string {
	if (reply.body !== undefined) return reply.body;
	const code = reply.code ?? 0;
	return JSON.stringify({ code, msg: reply.msg ?? (code === 0 ? "success" : "error"), data: {} });
}

export async function startFakeFeishu(): Promise<FakeFeishu> {
	const requests: FeishuRequest[] = [];
	const connects: string[] = [];
	const queued: FeishuReply[] = [];
	const queuedByPath = new Map<string, FeishuReply[]>();
	let fallback = ok;
	const sockets = new Set<Socket>();
	let inFlight = 0;
	let maxInFlight = 0;

	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			let json: unknown;
			try {
				json = JSON.parse(body);
			} catch {
				json = undefined;
			}
			const target = req.url ?? "/";
			const viaProxy = /^https?:\/\//i.test(target);
			requests.push({
				method: req.method ?? "GET",
				path: viaProxy ? new URL(target).pathname : target,
				headers: req.headers,
				body,
				json,
				viaProxy,
			});
			const path = viaProxy ? new URL(target).pathname : target;
			const reply = queuedByPath.get(path)?.shift() ?? queued.shift() ?? fallback;
			maxInFlight = Math.max(maxInFlight, ++inFlight);
			if (reply.hang) return;
			const respond = () => {
				res.writeHead(reply.status ?? 200, { "content-type": "application/json; charset=utf-8" });
				res.end(responseBody(reply), () => {
					inFlight--;
				});
			};
			if (reply.delayMs) setTimeout(respond, reply.delayMs).unref();
			else respond();
		});
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	server.on("connect", (req, socket) => {
		connects.push(req.url ?? "");
		socket.end("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

	return {
		origin,
		webhookUrl: (token = "default-token") => `${origin}/open-apis/bot/v2/hook/${token}`,
		requests,
		get maxInFlight() {
			return maxInFlight;
		},
		connects,
		reply: (...replies) => {
			queued.push(...replies);
		},
		replyTo: (token, ...replies) => {
			const path = new URL(`${origin}/open-apis/bot/v2/hook/${token}`).pathname;
			queuedByPath.set(path, [...(queuedByPath.get(path) ?? []), ...replies]);
		},
		replyAlways: (reply) => {
			fallback = reply;
		},
		close: () =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy();
				server.close(() => resolve());
			}),
	};
}
