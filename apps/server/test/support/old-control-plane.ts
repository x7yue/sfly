import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";

export interface OldControlPlane {
	url: string;
	/** 命令行请求过的运行摘要接口的路径（`/runs/:id/summary`）。 */
	summaryRequests: string[];
	close(): Promise<void>;
}

/** 控制面对不认识的路径的 404（`route <方法> <路径> not found`）。 */
const notFound = (method: string, path: string) =>
	JSON.stringify({ error: { code: "not_found", message: `route ${method} ${path} not found` } });

/**
 * 扮成比命令行旧的控制面：没有运行摘要接口（`GET /runs/:id/summary` 回 404，和不认识的路径一样），其余请求原样转给 `target`，
 * 响应边收边转发（运行的事件流也能过）。
 */
export async function startOldControlPlane(target: string): Promise<OldControlPlane> {
	const { hostname, port } = new URL(target);
	const summaryRequests: string[] = [];
	const server = createServer((req, res) => {
		const path = (req.url ?? "/").split("?")[0] ?? "/";
		if (req.method === "GET" && /^\/runs\/[^/]+\/summary$/.test(path)) {
			summaryRequests.push(path);
			res
				.writeHead(404, { "content-type": "application/json" })
				.end(notFound("GET", req.url ?? path));
			return;
		}
		const upstream = request(
			{ host: hostname, port, method: req.method, path: req.url, headers: req.headers },
			(response) => {
				res.writeHead(response.statusCode ?? 502, response.headers);
				response.pipe(res);
			},
		);
		upstream.on("error", () => res.writeHead(502).end());
		req.pipe(upstream);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${address.port}`,
		summaryRequests,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	};
}
