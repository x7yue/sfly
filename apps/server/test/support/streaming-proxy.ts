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
	requests: RecordedRequest[];
	readonly inFlight: number;
	cut(): void;
	hold(): void;
	release(): void;
	close(): Promise<void>;
}

const HOP_BY_HOP = ["connection", "keep-alive", "transfer-encoding"];

const endToEnd = (headers: IncomingHttpHeaders) =>
	Object.fromEntries(Object.entries(headers).filter(([key]) => !HOP_BY_HOP.includes(key)));

/** 记录请求头、边收边转发响应（支持 SSE）的 HTTP 代理，能切断连接、暂缓转发。 */
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
		get inFlight() {
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
