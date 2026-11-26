import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface AssistantProxy {
	url: string;
	close(): Promise<void>;
}

/**
 * 控制面和（真的）助手服务之间的转发：控制面写死工作区在 `/work`（骨架期间的桩，#549 换掉），而测试里的工作台是本机的临时目录；
 * 转发把交给助手服务的 `prompt` 里的工作区换成 `workdir`，别的请求原样转发（事件流照常流式）。
 */
export async function startAssistantProxy(
	target: string,
	workdir: string,
): Promise<AssistantProxy> {
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			let body = Buffer.concat(chunks);
			if (req.method === "POST" && /\/prompt$/.test(req.url ?? "")) {
				const parsed = JSON.parse(body.toString()) as { workbench: { workdir: string } };
				parsed.workbench.workdir = workdir;
				body = Buffer.from(JSON.stringify(parsed));
			}
			const headers = { ...req.headers };
			if (body.length > 0) headers["content-length"] = String(body.length);
			const upstream = request(`${target}${req.url}`, { method: req.method, headers }, (answer) => {
				res.writeHead(answer.statusCode ?? 502, answer.headers);
				answer.pipe(res);
				// 助手服务那边断了（被杀、重启）：这一头也断开，控制面才看得到连接没了（pipe 在上游被中止时不会结束下游）。
				answer.on("aborted", () => res.destroy());
				answer.on("error", () => res.destroy());
			});
			upstream.on("error", () => res.destroy());
			res.on("close", () => upstream.destroy());
			upstream.end(body);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}
