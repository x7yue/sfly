import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { create } from "@bufbuild/protobuf";
import type { ServiceImpl } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import {
	AgentGateway,
	type AgentMessage,
	type ServerMessage,
	ServerMessageSchema,
} from "@sfly/proto";

export interface AgentGatewayServer {
	/** 形如 http://127.0.0.1:50051，供 Agent 连接（h2c）。 */
	readonly url: string;
	close(): Promise<void>;
}

/**
 * Agent 网关服务实现：每个 Connect 调用是一个 Agent 的双向流。
 * 当前只做握手：收到 Hello 回复 Welcome。
 */
const gateway: ServiceImpl<typeof AgentGateway> = {
	async *session(requests: AsyncIterable<AgentMessage>): AsyncIterable<ServerMessage> {
		for await (const message of requests) {
			if (message.body.case === "hello") {
				yield create(ServerMessageSchema, { body: { case: "welcome", value: {} } });
			}
		}
	},
};

/**
 * 在独立端口上启动 Agent 网关：明文 HTTP/2（h2c）上的 Connect 路由，
 * 同时支持 gRPC、gRPC-Web 和 Connect 协议，tonic 客户端按标准 gRPC 连接。
 * 与 HTTP API 分开监听，因为 HTTP API 需要服务浏览器的 HTTP/1.1 请求。
 */
export async function startAgentGateway(options: {
	host: string;
	port: number;
}): Promise<AgentGatewayServer> {
	const handler = connectNodeAdapter({
		routes(router) {
			router.service(AgentGateway, gateway);
		},
	});
	const server = http2.createServer(handler);
	const sessions = new Set<http2.ServerHttp2Session>();
	server.on("session", (session) => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, options.host, () => {
			server.off("error", reject);
			resolve();
		});
	});
	const { port } = server.address() as AddressInfo;

	return {
		url: `http://${formatHost(options.host)}:${port}`,
		async close() {
			const closed = new Promise<void>((resolve) => server.close(() => resolve()));
			for (const session of sessions) session.destroy();
			await closed;
		},
	};
}

function formatHost(host: string): string {
	return host.includes(":") ? `[${host}]` : host;
}
