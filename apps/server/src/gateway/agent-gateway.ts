import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { create } from "@bufbuild/protobuf";
import {
	Code,
	ConnectError,
	createContextKey,
	createContextValues,
	type HandlerContext,
	type ServiceImpl,
} from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import {
	AgentGateway,
	type AgentMessage,
	type ServerMessage,
	ServerMessageSchema,
} from "@sfly/proto";
import { AGENT_NAME_MAX_LENGTH, describeNameProblem, nameProblem } from "@sfly/schema";
import type { AgentAuthenticator } from "../agents/agent-auth.js";
import { agentClockReading } from "../agents/agent-clock.js";
import { sourceAddress } from "../agents/agent-endpoint.js";
import {
	type AgentConnection,
	AgentConnectionRefused,
	type AgentHub,
	DEFAULT_SLOTS,
	devPackageInfo,
} from "../agents/agent-hub.js";
import { AsyncQueue } from "../util/async-queue.js";
import { listening } from "../util/listen-error.js";
import { storable } from "./storable.js";

export interface AgentGatewayServer {
	/** 形如 http://127.0.0.1:50051，供 Agent 连接（h2c）。 */
	readonly url: string;
	close(): Promise<void>;
}

/** 网关把握手之后的事件交给它处理（引擎）。 */
export interface AgentSessionHandler {
	/**
	 * 握手完成：处置 Agent 手上的任务（Hello.running_tasks）并推送 Welcome（`conn.welcome()`）。
	 * 派发等 Agent 准备好环境：Welcome 之后的第一次心跳（`conn.heartbeat()`）。
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

/**
 * Agent 发来的单条消息的大小上限（连接库的 `readMaxBytes`）：80 MiB。
 *
 * 这是防止内存被一条消息占满的兜底，不是正常路径上的限制。要高过还没升级的 Agent 能发出的最大的一条：一批日志（`LogBatch`）条数
 * 上限 1000、每行最多 64 KiB，但 Agent 自己的排队上限是 64 MiB，超过的整批在 Agent 那边就丢掉了（#663），所以它真正发得出的最大
 * 一条是 64 MiB 多一点；80 MiB 比它高一截，升级途中的 Agent 不会被拒。升级之后（#663）一批最多 2 MiB 加最后一条（日志一条
 * 约 0.3 MiB、动作明细约 128 KiB），节点输出结果限在 1 MB（`MAX_OUTPUT_BYTES`），指标一批 1 万个点：Agent 都升过 #663 之后可以降到
 * 16 MiB（docs/ARCHITECTURE.md）。
 */
export const AGENT_MESSAGE_MAX_BYTES = 80 * 1024 * 1024;

/** 一条消息超过上限、这条连接被关闭：只有哪台 Agent、来源地址、声明的大小和上限，没有消息的任何内容。 */
export interface MessageTooLarge {
	/** 哪台 Agent；握手（Hello）之前还不知道。 */
	agent: string | undefined;
	/** 连接的来源地址。 */
	source: string;
	/** 消息声明的大小（字节）；读不出来时为 undefined。 */
	size: number | undefined;
	/** 当时的上限（字节）。 */
	limit: number;
}

export interface AgentGatewayOptions {
	host: string;
	port: number;
	hub: AgentHub;
	handler?: AgentSessionHandler;
	/** Hello 里的凭据怎么认（Agent 凭据、共享令牌、没有凭据的过渡规则，src/agents/agent-auth.ts）。 */
	authenticator: AgentAuthenticator;
	onError?: (error: unknown) => void;
	/**
	 * Agent 发来的单条消息最多多少字节（默认 {@link AGENT_MESSAGE_MAX_BYTES}）。超过的这一台 Agent 的流以 `resource_exhausted`
	 * 结束（别的 Agent 的流不受影响）：库读到 5 字节的长度前缀、发现声明的长度超过上限就拒绝，不会先把整条收齐。
	 */
	readMaxBytes?: number;
	/** 一条消息超过上限、这条连接被关闭时调用（写一行日志用）。 */
	onMessageTooLarge?: (event: MessageTooLarge) => void;
}

/** 这次连接的来源地址（ADR 0019：没有显式配置对外地址的 Agent 以它为对外地址）。 */
const remoteAddressKey = createContextKey<string | undefined>(undefined, {
	description: "agent connection source address",
});

/**
 * 连接库读请求流时遇到的「消息超过 `readMaxBytes`」：是的话返回声明的大小（读不出来时 undefined），不是返回 null。
 * 库的错误文字是 `message size <声明的大小> is larger than configured readMaxBytes <上限>`，错误码 `resource_exhausted`。
 */
function tooLargeSize(error: unknown): { size: number | undefined } | null {
	if (!(error instanceof ConnectError) || error.code !== Code.ResourceExhausted) return null;
	if (!error.rawMessage.includes("larger than configured readMaxBytes")) return null;
	const size = /message size (\d+)/.exec(error.rawMessage)?.[1];
	return { size: size === undefined ? undefined : Number(size) };
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
			const source = sourceAddress(context.values.get(remoteAddressKey));
			const limit = options.readMaxBytes ?? AGENT_MESSAGE_MAX_BYTES;
			/** 读请求流时遇到消息超过上限：报告（只有哪台 Agent、来源地址、大小和上限）；是返回 true。 */
			const reportTooLarge = (error: unknown, agent?: string): boolean => {
				const found = tooLargeSize(error);
				if (found) options.onMessageTooLarge?.({ agent, source, size: found.size, limit });
				return found !== null;
			};
			// 握手之前的第一条消息就超过上限：还不知道是哪台 Agent，写来源地址；这个错误本身就让流以 resource_exhausted 结束。
			const first = await inbound.next().catch((error: unknown) => {
				reportTooLarge(error);
				throw error;
			});
			const greeting = first.done ? undefined : storable(first.value);
			if (greeting?.body.case !== "hello") {
				throw new ConnectError("first message must be Hello", Code.InvalidArgument);
			}
			// 收到 Hello 的控制面时间：这次连接的折算关系和第一次时钟偏差都按它算（ADR 0018）。
			const helloReceivedAt = options.hub.now();
			const hello = greeting.body.value;
			if (!hello.name) throw new ConnectError("Hello.name is required", Code.InvalidArgument);
			// Agent 的名称是身份，显示在命令行、控制台和场景里：和令牌的名称、显示名同一个检查（#670），不合格的连接不让上来。
			// 这一步在认证之前：认证拒绝连接的报错里带着 Hello 的名称（回给 Agent、Agent 每次重连都打到自己的标准错误上），
			// 不合格的名称不能经它们原样回显出去；报错本身只说是哪一类问题，不带名称。
			const nameIssue = nameProblem(hello.name);
			if (nameIssue !== undefined) {
				throw new ConnectError(
					`Hello.name 不合格：${describeNameProblem("Agent 的名称", nameIssue)}`,
					Code.InvalidArgument,
				);
			}
			if ([...hello.name].length > AGENT_NAME_MAX_LENGTH) {
				throw new ConnectError(
					`Hello.name 不合格：Agent 的名称不能超过 ${AGENT_NAME_MAX_LENGTH} 个字符`,
					Code.InvalidArgument,
				);
			}
			// 项目和名字从凭据得出：Agent 凭据按台签发，Hello.name 和它不一致、吊销的、停用的 Agent 都在这里拒绝。
			const outcome = await options.authenticator.authenticate(hello.token, hello.name);
			if (!outcome.ok) {
				throw new ConnectError(
					outcome.message,
					outcome.code === "unauthenticated" ? Code.Unauthenticated : Code.PermissionDenied,
				);
			}

			const outbox = new AsyncQueue<ServerMessage>();
			let conn: AgentConnection;
			try {
				conn = await options.hub.attach(
					outcome.project,
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
						capabilities: hello.capabilities.map((c) => ({ name: c.name, version: c.version })),
						...(hello.peer && {
							peer: {
								port: hello.peer.port,
								public_address: hello.peer.publicAddress,
								listen_error: hello.peer.listenError,
							},
						}),
						source_address: source,
					},
					outbox,
					agentClockReading(hello),
					helloReceivedAt,
					outcome.auth,
					() => options.authenticator.recheck(outcome.auth, hello.name, outcome.project),
				);
			} catch (error) {
				// 同名的、带 Agent 凭据的连接还活着（以旧方式连接的不能顶掉它，原连接不受影响），或者登记之前再看一遍时已经没有资格。
				if (error instanceof AgentConnectionRefused) {
					throw new ConnectError(
						error.message,
						error.code === "unauthenticated" ? Code.Unauthenticated : Code.PermissionDenied,
					);
				}
				throw error;
			}
			context.signal.addEventListener("abort", () => conn.close());

			// 入站消息在后台逐条处理；请求流结束或断线时注销连接。消息超过上限时记下这个错误：注销连接、出站队列结束之后，
			// 这条流以它（resource_exhausted）结束，Agent 看得到明确的错误，不是悄悄断开。
			let tooLarge: unknown;
			void (async () => {
				try {
					const running = hello.runningTasks.map(runningTaskRef);
					if (options.handler) await options.handler.onOnline(conn, running);
					else
						conn.welcome(
							create(ServerMessageSchema, { body: { case: "welcome", value: {} } }),
							options.hub.now(),
						);
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
					if (reportTooLarge(error, hello.name)) tooLarge = error;
					else if (!conn.closed) options.onError?.(error);
				} finally {
					await options.hub.detach(conn).catch((error) => options.onError?.(error));
				}
			})();

			yield* outbox;
			if (tooLarge) throw tooLarge;
		},
	};
}

/**
 * 在独立端口上启动 Agent 网关：明文 HTTP/2（h2c）上的 Connect 路由，
 * 同时支持 gRPC、gRPC-Web 和 Connect 协议，tonic 客户端按标准 gRPC 连接。
 * 与 HTTP API 分开监听，因为 HTTP API 需要服务浏览器的 HTTP/1.1 请求。
 */
export async function startAgentGateway(options: AgentGatewayOptions): Promise<AgentGatewayServer> {
	const readMaxBytes = options.readMaxBytes ?? AGENT_MESSAGE_MAX_BYTES;
	// 消息的长度前缀是 4 个字节：上限不能是 0、小数，也不能比它能表示的还大。
	if (!Number.isSafeInteger(readMaxBytes) || readMaxBytes < 1 || readMaxBytes > 0xffffffff) {
		throw new RangeError(
			`Agent 网关的 readMaxBytes 要是 1 到 4294967295 的整数，不是 ${readMaxBytes}`,
		);
	}
	const handler = connectNodeAdapter({
		readMaxBytes,
		routes(router) {
			router.service(AgentGateway, gatewayService(options));
		},
		contextValues: (req) => createContextValues().set(remoteAddressKey, req.socket.remoteAddress),
	});
	const server = http2.createServer(handler);
	const sessions = new Set<http2.ServerHttp2Session>();
	server.on("session", (session) => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});

	// 监听不了时的说明只有变量名、端口和错误码（util/listen-error.ts）：Node 的报错会把监听地址原样带出来。
	await listening(
		"grpc",
		options.port,
		() =>
			new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(options.port, options.host, () => {
					server.off("error", reject);
					resolve();
				});
			}),
	);
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
