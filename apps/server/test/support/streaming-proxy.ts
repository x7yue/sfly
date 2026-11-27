import {
	createServer,
	type IncomingHttpHeaders,
	type IncomingMessage,
	request,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { RecordedRequest } from "./recording-proxy.js";
import { aliasCliServer } from "./sfly-cli.js";

export interface StreamingProxy {
	url: string;
	requests: RecordedRequest[];
	readonly inFlight: number;
	cut(): void;
	/**
	 * 此刻已经在转发的响应，之后的字节一个也不再往客户端转（也不关连接，没有 FIN、没有 RST）：中间的设备悄悄丢了这条连接
	 * （休眠醒来、网络切换、NAT 表项过期）、或者对端半开时客户端看到的样子。之后新来的请求不受影响（像网络恢复了一样）。
	 */
	stall(): void;
	hold(): void;
	release(): void;
	close(): Promise<void>;
}

export interface StreamingProxyOptions {
	/**
	 * 一条响应超过这么久（毫秒）没有从控制面收到任何字节就把它切断：反向代理的「空闲超时」（nginx 的 `proxy_read_timeout`、
	 * 云上负载均衡的空闲超时，常见 60 秒）。控制面的心跳也算字节，所以心跳间隔短于它的流不会被切。
	 */
	idleTimeoutMs?: number;
}

const HOP_BY_HOP = ["connection", "keep-alive", "transfer-encoding"];

const endToEnd = (headers: IncomingHttpHeaders) =>
	Object.fromEntries(Object.entries(headers).filter(([key]) => !HOP_BY_HOP.includes(key)));

/** 记录请求头、边收边转发响应（支持 SSE）的 HTTP 代理，能切断连接、暂缓转发。 */
export async function startStreamingProxy(
	target: string,
	options: StreamingProxyOptions = {},
): Promise<StreamingProxy> {
	const { hostname, port, host } = new URL(target);
	const requests: RecordedRequest[] = [];
	const forwarded = new Set<ServerResponse>();
	const stalled = new Set<ServerResponse>();
	let held: Array<() => void> | undefined;

	const forward = (req: IncomingMessage, res: ServerResponse) => {
		forwarded.add(res);
		const upstream = request(
			{
				host: hostname,
				port,
				method: req.method,
				path: req.url,
				headers: { ...endToEnd(req.headers), host },
				agent: false,
			},
			(answer) => {
				res.writeHead(answer.statusCode ?? 502, endToEnd(answer.headers));
				let idle: NodeJS.Timeout | undefined;
				const rearm = () => {
					if (options.idleTimeoutMs === undefined) return;
					clearTimeout(idle);
					idle = setTimeout(() => res.socket?.destroy(), options.idleTimeoutMs);
				};
				rearm();
				answer.on("data", (chunk: Buffer) => {
					rearm();
					if (stalled.has(res)) return;
					// 客户端读得慢时让控制面也慢下来（和 `pipe` 一样）。
					if (!res.write(chunk)) {
						answer.pause();
						res.once("drain", () => answer.resume());
					}
				});
				answer.on("end", () => {
					clearTimeout(idle);
					if (!stalled.has(res)) res.end();
				});
				res.on("close", () => clearTimeout(idle));
			},
		);
		upstream.on("error", () => {
			if (res.headersSent) res.destroy();
			else res.writeHead(502).end();
		});
		res.on("close", () => {
			forwarded.delete(res);
			stalled.delete(res);
			upstream.destroy();
		});
		req.pipe(upstream);
	};

	const server = createServer((req, res) => {
		requests.push({ method: req.method ?? "GET", path: req.url ?? "/", headers: req.headers });
		if (held) held.push(() => forward(req, res));
		else forward(req, res);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;

	aliasCliServer(`http://127.0.0.1:${address.port}`, target);
	return {
		url: `http://127.0.0.1:${address.port}`,
		requests,
		get inFlight() {
			return forwarded.size;
		},
		cut() {
			for (const res of forwarded) res.socket?.destroy();
		},
		stall() {
			for (const res of forwarded) stalled.add(res);
		},
		hold() {
			held ??= [];
		},
		release() {
			const queued = held ?? [];
			held = undefined;
			for (const send of queued) send();
		},
		close: () =>
			new Promise<void>((resolve) => {
				held = undefined;
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	};
}
