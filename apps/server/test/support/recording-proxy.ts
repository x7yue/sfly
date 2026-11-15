import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
	method: string;
	path: string;
	headers: IncomingHttpHeaders;
}

export interface RecordingProxy {
	url: string;
	requests: RecordedRequest[];
	close(): Promise<void>;
}

const HOP_BY_HOP = ["connection", "keep-alive", "transfer-encoding", "content-length", "host"];

/**
 * 记录请求再原样转给 target 的代理：测试里用来观察命令行实际发出的请求头、区分命令行连的是哪个地址。
 * 只转发有完整响应体的普通请求（不处理流式响应）。`before` 在转发每个请求之前执行，
 * 测试用它在两个请求之间改动控制面的状态（例如预检之后、触发之前删掉运行预设）。
 */
export async function startRecordingProxy(
	target: string,
	before?: (request: RecordedRequest) => Promise<void>,
): Promise<RecordingProxy> {
	const requests: RecordedRequest[] = [];
	const server = createServer((req, res) => {
		void (async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(chunk as Buffer);
			const recorded = { method: req.method ?? "GET", path: req.url ?? "/", headers: req.headers };
			requests.push(recorded);
			await before?.(recorded);
			const headers = new Headers();
			for (const [key, value] of Object.entries(req.headers)) {
				if (HOP_BY_HOP.includes(key) || value === undefined) continue;
				headers.set(key, Array.isArray(value) ? value.join(", ") : value);
			}
			const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
			const upstream = await fetch(`${target}${req.url}`, { method: req.method, headers, body });
			const response = new Headers(upstream.headers);
			for (const key of [...HOP_BY_HOP, "content-encoding"]) response.delete(key);
			res.writeHead(upstream.status, Object.fromEntries(response));
			res.end(Buffer.from(await upstream.arrayBuffer()));
		})().catch((error: unknown) => {
			res.writeHead(502).end(String(error));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	};
}
