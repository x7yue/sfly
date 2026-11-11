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
import { agentClockReading } from "../agents/agent-clock.js";
import {
	type AgentConnection,
	type AgentHub,
	DEFAULT_SLOTS,
	devPackageInfo,
} from "../agents/agent-hub.js";
import { agentTokenMatches } from "../agents/agent-token.js";
import { AsyncQueue } from "../util/async-queue.js";
import { storable } from "./storable.js";

export interface AgentGatewayServer {
	/** 形如 http://127.0.0.1:50051，供 Agent 连接（h2c）。 */
	readonly url: string;
	close(): Promise<void>;
}

/** 网关把握手之后的事件交给它处理（引擎）。 */
export interface AgentSessionHandler {
	/**
	 * 握手完成：处置 Agent 手上的任务（Hello.running_tasks）并推送 Welcome（`conn.welcome()`），
	 * 然后开始派发任务。
	 */
	onOnline(conn: AgentConnection, runningTasks: RunningTaskRef[]): Promise<void>;
	/**
	 * 握手之后 Agent 发来的消息（字符串里的 NUL 已换成 U+FFFD，见 ./storable.ts）。
	 * 抛出的错误只影响这一条：网关记下来（`onError`），接着处理后面的消息，不关闭这条流。
	 * 任务结果例外：抛出表示结果没有落定（没回 Ack），网关关闭这条流，Agent 重连后重发。
	 */
	onMessage(conn: AgentConnection, message: AgentMessage): Promise<void>;
}

/** Agent 在 Hello 中上报的、手上的任务。 */
export interface RunningTaskRef {
	taskId: string;
	attempt: number;
	/** 执行器子进程已经启动（TaskStarted 可能随断开的连接丢失）。 */
	started: boolean;
}

export interface AgentGatewayOptions {
	host: string;
	port: number;
	hub: AgentHub;
	handler?: AgentSessionHandler;
	/** 共享注册令牌；未设置（或为空串）时不校验。 */
	agentToken?: string;
	onError?: (error: unknown) => void;
}

/** proto 的 RunningTask（Hello、Heartbeat 里 Agent 手上的任务）。 */
export const runningTaskRef = (t: { taskId: string; attempt: number; started: boolean }) => ({
	taskId: t.taskId,
	attempt: t.attempt,
	started: t.started,
});

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
			const greeting = first.done ? undefined : storable(first.value);
			if (greeting?.body.case !== "hello") {
				throw new ConnectError("first message must be Hello", Code.InvalidArgument);
			}
			// 收到 Hello 的控制面时间：这次连接的折算关系和第一次时钟偏差都按它算（ADR 0018）。
			const helloReceivedAt = options.hub.now();
			const hello = greeting.body.value;
			if (!hello.name) throw new ConnectError("Hello.name is required", Code.InvalidArgument);
			if (!agentTokenMatches(options.agentToken, hello.token)) {
				throw new ConnectError("invalid agent token", Code.Unauthenticated);
			}

			const outbox = new AsyncQueue<ServerMessage>();
			const conn = await options.hub.attach(
				hello.name,
				{
					agent_version: hello.agentVersion,
					os: hello.os,
					arch: hello.arch,
					slots: hello.slots > 0 ? hello.slots : DEFAULT_SLOTS,
					installed_packages: hello.installedPackages.map((p) => ({
						name: p.name,
						version: p.version,
					})),
					dev_packages: hello.devPackages.map(devPackageInfo),
				},
				outbox,
				agentClockReading(hello),
				helloReceivedAt,
			);
			context.signal.addEventListener("abort", () => conn.close());

			// 入站消息在后台逐条处理；请求流结束或断线时注销连接。
			void (async () => {
				try {
					const running = hello.runningTasks.map(runningTaskRef);
					if (options.handler) await options.handler.onOnline(conn, running);
					else conn.welcome(create(ServerMessageSchema, { body: { case: "welcome", value: {} } }));
					for (;;) {
						const next = await inbound.next();
						if (next.done || conn.closed) break;
						const message = storable(next.value);
						try {
							if (message.body.case === "heartbeat") {
								// 每次心跳更新时钟偏差；不带时钟读数的心跳（旧版本 Agent）不改变保存的值。
								const reading = agentClockReading(message.body.value);
								if (reading) await options.hub.recordClock(conn, reading, options.hub.now());
							}
							await options.handler?.onMessage(conn, message);
						} catch (error) {
							// 一条消息处理失败（例如写库失败）不关闭这条流：这台 Agent 上其他任务的上报照常处理（#207）。
							// 结果没有落定时关闭，Agent 重连后重发（AgentSessionHandler.onMessage）。
							if (message.body.case === "result" || conn.closed) throw error;
							options.onError?.(error);
						}
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
