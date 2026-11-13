import {
	createServer,
	type IncomingHttpHeaders,
	type IncomingMessage,
	request,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { RecordedRequest } from "./recording-proxy.js";

export interface StreamingProxy {
	url: string;
	/** 按到达顺序记下的每个请求，包括被 hold() 住、还没转发的。 */
	requests: RecordedRequest[];
	/** 已经转发、响应还没结束的请求数：一条事件流在断开之前一直算在里面。 */
	readonly open: number;
	/** 切断所有已经转发的请求的连接（模拟网络中断）；之后的新请求照常转发。 */
	cut(): void;
	/** 之后到达的请求先记下、不转发，直到 release()：让断线期间的变化一定发生在重连之前。 */
	hold(): void;
	release(): void;
	close(): Promise<void>;
}

const HOP_BY_HOP = ["connection", "keep-alive", "transfer-encoding"];

const endToEnd = (headers: IncomingHttpHeaders) =>
	Object.fromEntries(Object.entries(headers).filter(([key]) => !HOP_BY_HOP.includes(key)));

/**
 * 记录请求头、边收边转发响应（支持 SSE）的 HTTP 代理，并能切断连接、暂缓转发：
 * 测试里用来观察 API 客户端重连时发出的请求，模拟它和控制面之间的网络中断。
 */
export async function startStreamingProxy(target: string): Promise<StreamingProxy> {
	const { hostname, port, host } = new URL(target);
	const requests: RecordedRequest[] = [];
	const forwarded = new Set<ServerResponse>();
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
				answer.pipe(res);
			},
		);
		upstream.on("error", () => {
			if (res.headersSent) res.destroy();
			else res.writeHead(502).end();
		});
		res.on("close", () => {
			forwarded.delete(res);
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

	return {
		url: `http://127.0.0.1:${address.port}`,
		requests,
		get open() {
			return forwarded.size;
		},
		cut() {
			for (const res of forwarded) res.socket?.destroy();
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
