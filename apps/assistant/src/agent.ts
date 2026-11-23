// 连到一台 Agent 的能力端口（默认 50052，ADR 0019）：执行命令、读文件、写文件、查文件属性。
// 端口上是 tonic 的 gRPC 服务，没有认证；这里用 connect-node 的 gRPC 传输（HTTP/2）。
// 从评测集的远程工具扩展（evals/assistant/remote-tools/agent.ts）搬过来；远程工具扩展和助手服务（往工作台上写 skill）都用它。

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import {
	AgentExec,
	AgentFileRead,
	AgentFiles,
	AgentFileWrite,
	AgentPeer,
	OutputStream,
	RunCommandRequestSchema,
	type WriteFileRequest,
	WriteFileRequestSchema,
} from "@sfly/proto";

/** 写文件时每条消息带多少字节。 */
const CHUNK = 256 * 1024;

/**
 * 命令的期限在它自己的超时之外留的余量：超时由 Agent 执行，到时它结束命令、回一个结果；过了这个余量还没有回应，
 * 就当作工作台没有回话（和 Agent 自己做节点调用时的 `REPLY_SLACK` 同一个数，agent/src/capabilities/exec.rs）。
 */
export const REPLY_SLACK_MS = 10_000;
/** 读、写、查文件属性的期限。 */
export const FILE_DEADLINE_MS = 60_000;
/** 期限到了之后探一下工作台还在不在：这么久没有回应就当作连不上。 */
export const PROBE_DEADLINE_MS = 5_000;
/** HTTP/2 连接的保活：每隔这么久发一个 ping，这么久没有回应就关掉连接（连接上进行中的调用随之报错）。 */
const PING_INTERVAL_MS = 15_000;
const PING_TIMEOUT_MS = 10_000;

/** 工作台连不上时工具结果、`turn_end` 的原因的开头：助手服务据此结束这一轮（sessions.ts）。 */
export const WORKBENCH_UNREACHABLE = "工作台连不上";

export class TimeoutError extends Error {}

/** 工作台连不上（消息以 {@link WORKBENCH_UNREACHABLE} 开头）。 */
export class UnreachableError extends Error {}

/**
 * 一次调用过了期限还没有回应。`reachable` 是之后探一下工作台的结果：探得通时只是这一次调用卡住了，
 * 探不通时消息以 {@link WORKBENCH_UNREACHABLE} 开头。
 */
export class DeadlineError extends Error {
	constructor(
		readonly what: string,
		readonly seconds: number,
		readonly reachable: boolean,
		address: string,
	) {
		super(
			reachable
				? `工作台 ${address} 在 ${seconds} 秒内没有回应这次${what}（工作台还连得上，只是这次调用卡住了）`
				: `${WORKBENCH_UNREACHABLE}：${address} 在 ${seconds} 秒内没有回应这次${what}，之后也探不通`,
		);
	}
}

export interface ExecOptions {
	cwd: string;
	env?: Record<string, string>;
	timeoutMs: number;
	signal?: AbortSignal;
	onData?: (data: Uint8Array, stream: "stdout" | "stderr") => void;
}

/** 期限（测试里改短）。 */
export interface AgentDeadlines {
	replySlackMs?: number;
	fileDeadlineMs?: number;
	probeDeadlineMs?: number;
}

export function connectAgent(address: string, deadlines: AgentDeadlines = {}) {
	const replySlack = deadlines.replySlackMs ?? REPLY_SLACK_MS;
	const fileDeadline = deadlines.fileDeadlineMs ?? FILE_DEADLINE_MS;
	const probeDeadline = deadlines.probeDeadlineMs ?? PROBE_DEADLINE_MS;
	const transport = createGrpcTransport({
		baseUrl: `http://${address}`,
		pingIntervalMs: PING_INTERVAL_MS,
		pingTimeoutMs: PING_TIMEOUT_MS,
		pingIdleConnection: true,
	});
	const exec = createClient(AgentExec, transport);
	const read = createClient(AgentFileRead, transport);
	const write = createClient(AgentFileWrite, transport);
	const files = createClient(AgentFiles, transport);
	const peer = createClient(AgentPeer, transport);

	/** 工作台还连不连得上：{@link PROBE_DEADLINE_MS} 之内能回 `describe`。 */
	const reachable = async (): Promise<boolean> => {
		try {
			await peer.describe({}, { signal: AbortSignal.timeout(probeDeadline) });
			return true;
		} catch {
			return false;
		}
	};

	/**
	 * 带期限做一次调用：`call` 拿到一个合并了调用方取消和期限的信号。期限到时（调用方没有取消）抛 {@link DeadlineError}。
	 */
	async function withDeadline<T>(
		what: string,
		ms: number,
		outer: AbortSignal | undefined,
		call: (signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		const deadline = new AbortController();
		const timer = setTimeout(() => deadline.abort(), ms);
		const signal = outer ? AbortSignal.any([outer, deadline.signal]) : deadline.signal;
		try {
			return await call(signal);
		} catch (error) {
			if (deadline.signal.aborted && !outer?.aborted) {
				throw new DeadlineError(what, Number((ms / 1000).toFixed(1)), await reachable(), address);
			}
			// 连接断了（对端关了连接、保活的 ping 没有回应）：探一下，探不通就是工作台连不上。
			if (
				error instanceof ConnectError &&
				error.code === Code.Unavailable &&
				!outer?.aborted &&
				!(await reachable())
			) {
				throw new UnreachableError(`${WORKBENCH_UNREACHABLE}：${address}（${error.rawMessage}）`);
			}
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}

	return {
		describe: () => peer.describe({}, { signal: AbortSignal.timeout(probeDeadline) }),
		reachable,

		/** 执行一条命令（argv 不经 shell），返回退出码；超时抛 TimeoutError，调用方放弃时抛 "aborted"。 */
		async run(argv: string[], options: ExecOptions): Promise<number> {
			const request = create(RunCommandRequestSchema, {
				argv,
				cwd: options.cwd,
				env: options.env ?? {},
				timeoutMs: BigInt(options.timeoutMs),
			});
			try {
				return await withDeadline(
					"命令",
					options.timeoutMs + replySlack,
					options.signal,
					async (signal) => {
						for await (const response of exec.run(request, { signal })) {
							if (response.part.case === "output") {
								const { stream, data } = response.part.value;
								options.onData?.(data, stream === OutputStream.STDERR ? "stderr" : "stdout");
							} else if (response.part.case === "exit") {
								return response.part.value.exitCode;
							}
						}
						throw new Error(`命令没有返回退出码：${argv.join(" ")}`);
					},
				);
			} catch (error) {
				if (options.signal?.aborted) throw new Error("aborted");
				if (error instanceof ConnectError && error.code === Code.DeadlineExceeded) {
					throw new TimeoutError(error.rawMessage);
				}
				throw error;
			}
		},

		/**
		 * 按块读一个文件：每一块都要在 {@link FILE_DEADLINE_MS} 之内到（不限整个文件读多久，只限多久没有动静）。
		 */
		async *readChunks(path: string, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
			const idle = new AbortController();
			let timer = setTimeout(() => idle.abort(), fileDeadline);
			const merged = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal;
			try {
				for await (const response of read.read({ path }, { signal: merged })) {
					clearTimeout(timer);
					timer = setTimeout(() => idle.abort(), fileDeadline);
					if (response.data.length > 0) yield response.data;
				}
			} catch (error) {
				if (idle.signal.aborted && !signal?.aborted) {
					throw new DeadlineError(
						"读文件",
						Number((fileDeadline / 1000).toFixed(1)),
						await reachable(),
						address,
					);
				}
				throw error;
			} finally {
				clearTimeout(timer);
			}
		},

		/** 读一个文件的开头（最多 `length` 字节，探文件类型用）。 */
		readHead: (path: string, length: number, signal?: AbortSignal) =>
			withDeadline("读文件", fileDeadline, signal, async (s) => {
				const parts: Uint8Array[] = [];
				for await (const response of read.read({ path, length: BigInt(length) }, { signal: s })) {
					parts.push(response.data);
				}
				return Buffer.concat(parts);
			}),

		readFile: (path: string, signal?: AbortSignal): Promise<Buffer> =>
			withDeadline("读文件", fileDeadline, signal, async (s) => {
				const parts: Uint8Array[] = [];
				for await (const response of read.read({ path }, { signal: s })) parts.push(response.data);
				return Buffer.concat(parts);
			}),

		stat: (path: string, signal?: AbortSignal) =>
			withDeadline("查文件属性", fileDeadline, signal, (s) => files.stat({ path }, { signal: s })),

		/** 写一个文件：内容是一段字节，或者按块给出的字节（不用整份放进内存）。 */
		writeFile: (
			path: string,
			content: Uint8Array | AsyncIterable<Uint8Array>,
			signal?: AbortSignal,
		): Promise<void> =>
			withDeadline("写文件", fileDeadline, signal, async (s) => {
				async function* messages(): AsyncGenerator<WriteFileRequest> {
					yield create(WriteFileRequestSchema, { part: { case: "start", value: { path } } });
					let size = 0;
					const chunks =
						content instanceof Uint8Array
							? (function* () {
									for (let offset = 0; offset < content.length; offset += CHUNK) {
										yield content.subarray(offset, offset + CHUNK);
									}
								})()
							: content;
					for await (const chunk of chunks) {
						size += chunk.length;
						yield create(WriteFileRequestSchema, { part: { case: "data", value: chunk } });
					}
					yield create(WriteFileRequestSchema, {
						part: { case: "end", value: { size: BigInt(size) } },
					});
				}
				await write.write(messages(), { signal: s });
			}),
	};
}

export type AgentClient = ReturnType<typeof connectAgent>;

/** 把能力端口的错误换成和本地文件系统一样的说法（pi 的工具和模型都认 ENOENT 这类前缀）。 */
export function asFsError(error: unknown, op: string, path: string): Error {
	if (error instanceof ConnectError) {
		if (error.code === Code.NotFound)
			return new Error(`ENOENT: no such file or directory, ${op} '${path}'`);
		if (error.code === Code.PermissionDenied)
			return new Error(`EACCES: permission denied, ${op} '${path}'`);
		if (error.code === Code.InvalidArgument && /目录/.test(error.rawMessage)) {
			return new Error(`EISDIR: illegal operation on a directory, ${op} '${path}'`);
		}
		return new Error(`${op} '${path}' 失败：${error.rawMessage}`);
	}
	return error instanceof Error ? error : new Error(String(error));
}
