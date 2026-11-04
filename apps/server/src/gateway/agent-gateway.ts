import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import {
	AgentGateway,
	type AgentMessage,
	type ServerMessage,
	ServerMessageSchema,
} from "@sfly/proto";
import { type AgentConnection, type AgentHub, DEFAULT_SLOTS } from "../agents/agent-hub.js";
import { AsyncQueue } from "../util/async-queue.js";

export interface AgentGatewayServer {
	/** 形如 http://127.0.0.1:50051，供 Agent 连接（h2c）。 */
	readonly url: string;
	close(): Promise<void>;
}

/** 网关把握手之后的事件交给它处理（引擎）。 */
export interface AgentSessionHandler {
	/** Welcome 已推送，可以开始派发任务。 */
	onOnline(conn: AgentConnection): Promise<void>;
	/** 握手之后 Agent 发来的消息。 */
	onMessage(conn: AgentConnection, message: AgentMessage): Promise<void>;
}

export interface AgentGatewayOptions {
	host: string;
	port: number;
	hub: AgentHub;
	handler?: AgentSessionHandler;
	/** 共享注册令牌；未设置时不校验。 */
	agentToken?: string;
	onError?: (error: unknown) => void;
}

/**
 * Agent 网关服务实现：每个 Session 调用是一个 Agent 的双向流。
 * 第一条消息必须是 Hello；握手后出站消息走连接自己的队列，控制面可以随时推送。
 */
function gatewayService(options: AgentGatewayOptions): ServiceImpl<typeof AgentGateway> {
	return {
		async *session(
			requests: AsyncIterable<AgentMessage>,
			context: HandlerContext,
		): AsyncIterable<ServerMessage> {
			const inbound = requests[Symbol.asyncIterator]();
			const first = await inbound.next();
			if (first.done || first.value.body.case !== "hello") {
				throw new ConnectError("first message must be Hello", Code.InvalidArgument);
			}
			const hello = first.value.body.value;
			if (!hello.name) throw new ConnectError("Hello.name is required", Code.InvalidArgument);
			if (options.agentToken !== undefined && hello.token !== options.agentToken) {
				throw new ConnectError("invalid agent token", Code.Unauthenticated);
			}

			const outbox = new AsyncQueue<ServerMessage>();
			outbox.push(create(ServerMessageSchema, { body: { case: "welcome", value: {} } }));
			const conn = await options.hub.attach(
				hello.name,
				{
					agent_version: hello.agentVersion,
					os: hello.os,
					arch: hello.arch,
					slots: hello.slots > 0 ? hello.slots : DEFAULT_SLOTS,
				},
				outbox,
			);
			context.signal.addEventListener("abort", () => conn.close());

			// 入站消息在后台逐条处理；请求流结束或断线时注销连接。
			void (async () => {
				try {
					await options.handler?.onOnline(conn);
					for (;;) {
						const next = await inbound.next();
						if (next.done || conn.closed) break;
						await options.handler?.onMessage(conn, next.value);
					}
				} catch (error) {
					if (!conn.closed) options.onError?.(error);
				} finally {
					await options.hub.detach(conn).catch((error) => options.onError?.(error));
				}
			})();

			yield* outbox;
		},
	};
}

/**
 * 在独立端口上启动 Agent 网关：明文 HTTP/2（h2c）上的 Connect 路由，
 * 同时支持 gRPC、gRPC-Web 和 Connect 协议，tonic 客户端按标准 gRPC 连接。
 * 与 HTTP API 分开监听，因为 HTTP API 需要服务浏览器的 HTTP/1.1 请求。
 */
export async function startAgentGateway(options: AgentGatewayOptions): Promise<AgentGatewayServer> {
	const handler = connectNodeAdapter({
		routes(router) {
			router.service(AgentGateway, gatewayService(options));
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
