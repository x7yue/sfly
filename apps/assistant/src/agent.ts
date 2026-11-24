// 连到一台 Agent 的能力端口（默认 50052，ADR 0019）：执行命令、读文件、写文件、查文件属性。
// 端口上是 tonic 的 gRPC 服务，没有认证；这里用 connect-node 的 gRPC 传输（HTTP/2）。
// 从评测集的远程工具扩展（evals/assistant/remote-tools/agent.ts）搬过来；远程工具扩展和助手服务（往工作台上写 skill）都用它。

import type { ClientSessionOptions } from "node:http2";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport, Http2SessionManager } from "@connectrpc/connect-node";
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
import { writeLog } from "./output.js";

/** 写文件时每条消息带多少字节。 */
const CHUNK = 256 * 1024;

/**
 * 命令的期限在它自己的超时之外留的余量：超时由 Agent 执行，到时它先 SIGTERM 整棵进程树、最多等宽限（默认 10 秒）再
 * SIGKILL，再等管道最多 2 秒，然后才回复（agent/src/capabilities/exec.rs）；命令自己退出、留下不理 SIGTERM 的子进程时
 * 退出码也要晚这么久。所以余量是宽限加管道再留几秒：过了它还没有回应，才当作工作台没有回话。
 * （Agent 自己做节点调用时用的是「超时 + 宽限 + REPLY_SLACK」，和这里的算法一样。）
 * 宽限是 Agent 的 `--terminate-grace`（`SFLY_TERMINATE_GRACE`），能力端口不告诉调用方，这里按默认的 10 秒算：配得超过约
 * 18 秒时，不理 SIGTERM 的命令超时之后先到的是这里的期限，模型看到的是「工作台没有回应这次命令（还连得上）」，
 * 这一轮照常往下走。
 */
export const REPLY_SLACK_MS = 20_000;
/** 读、写、查文件属性的期限。 */
export const FILE_DEADLINE_MS = 60_000;
/** 期限到了之后探一下工作台还在不在：这么久没有回应就当作连不上。 */
export const PROBE_DEADLINE_MS = 5_000;
/**
 * HTTP/2 连接的保活：每隔这么久发一个 ping，这么久没有回应就关掉连接（连接上进行中的调用随之报错）。命令的期限是它的超时
 * 加余量，默认超时 20 分钟；连接在命令进行中冻住（容器被暂停、网络断了却没关连接）时，只有保活能及时发现。
 */
export const PING_INTERVAL_MS = 15_000;
export const PING_TIMEOUT_MS = 10_000;

/** 工作台连不上时工具结果、`turn_end` 的原因的开头：助手服务看到它时自己再探一次工作台，探不通才结束这一轮（sessions.ts）。 */
export const WORKBENCH_UNREACHABLE = "工作台连不上";

/**
 * 工作台这条连接上出的错，消息可以给模型、进工具结果、到页面（#640）：要么是助手服务自己的说法，要么是 Agent 自己
 * 给出的应用层的回答（{@link AgentAnswer}）。这条连接上的错误都先换成它再往外抛：认得的才放行，认不出的换成助手服务
 * 自己的说法，原文只进日志（{@link AgentOptions.log}）。连接层的原文里有工作台的地址，有的系统上还有助手服务这一侧的。
 */
export class WorkbenchError extends Error {}

/** 命令超过了它自己的超时（Agent 结束了它）。 */
export class TimeoutError extends WorkbenchError {}

/** 工作台连不上（消息以 {@link WORKBENCH_UNREACHABLE} 开头）。 */
export class UnreachableError extends WorkbenchError {}

/**
 * Agent 自己给出的应用层的回答：文件不存在、没有权限、参数不对（是目录、不是绝对路径）、文件已经不是原来的那个。
 * `code` 是它的状态码，消息是它的原话（只说到调用方给的路径）。
 */
export class AgentAnswer extends WorkbenchError {
	constructor(
		readonly code: Code,
		message: string,
	) {
		super(message);
	}
}

/** 原样放行的 Agent 回答：应用层的这几种。别的状态码（内部错误、输出中断、数据不全……）不放行原话。 */
const ANSWERS = new Set([
	Code.NotFound,
	Code.PermissionDenied,
	Code.InvalidArgument,
	Code.FailedPrecondition,
	Code.AlreadyExists,
	Code.OutOfRange,
]);

/**
 * 一次调用过了期限还没有回应。`reachable` 是之后探一下工作台的结果：探得通时只是这一次调用卡住了，
 * 探不通时消息以 {@link WORKBENCH_UNREACHABLE} 开头。
 */
export class DeadlineError extends WorkbenchError {
	constructor(
		readonly what: string,
		readonly seconds: number,
		readonly reachable: boolean,
	) {
		// 不带工作台的地址：这句话会进工具结果、显示在页面上（#640）。
		super(
			reachable
				? `工作台在 ${seconds} 秒内没有回应这次${what}（工作台还连得上，只是这次调用卡住了）`
				: `${WORKBENCH_UNREACHABLE}：在 ${seconds} 秒内没有回应这次${what}，之后也探不通`,
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

/** 期限（测试里改短）和日志的出口。 */
export interface AgentOptions {
	replySlackMs?: number;
	fileDeadlineMs?: number;
	probeDeadlineMs?: number;
	pingIntervalMs?: number;
	pingTimeoutMs?: number;
	/**
	 * 认不出、不放行的错误的原文写到哪里（带工作台的地址）。默认整行写到标准错误（output.ts 的 `writeLog`，不截断）：
	 * 在 pi 里（远程工具扩展）它进 pi 的标准错误，助手服务按这个会话的保密值打码后存下（先截断会把一个值切成认不出的
	 * 半截）；助手服务自己用时传它的日志出口（会话里先过 `#forLog`，别处是 `writeRawLog`）。
	 */
	log?: (line: string) => void;
	/** 建 HTTP/2 连接的选项（测试里换掉建连接的办法，造主机不可达这类连接层的失败）。 */
	http2?: ClientSessionOptions;
}

export function connectAgent(address: string, options: AgentOptions = {}) {
	const replySlack = options.replySlackMs ?? REPLY_SLACK_MS;
	const fileDeadline = options.fileDeadlineMs ?? FILE_DEADLINE_MS;
	const probeDeadline = options.probeDeadlineMs ?? PROBE_DEADLINE_MS;
	const log = options.log ?? writeLog;
	// 自己管这条 HTTP/2 连接：用完的客户端（助手服务探一次工作台、一轮开头写 skill）要能关掉它，不然它空闲 15 分钟
	// 才关、其间每 15 秒 ping 一次。
	const connection = new Http2SessionManager(
		`http://${address}`,
		{
			pingIntervalMs: options.pingIntervalMs ?? PING_INTERVAL_MS,
			pingTimeoutMs: options.pingTimeoutMs ?? PING_TIMEOUT_MS,
			pingIdleConnection: true,
		},
		options.http2,
	);
	const transport = createGrpcTransport({
		baseUrl: `http://${address}`,
		sessionManager: connection,
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
	 * 这条连接上的错误换成能往外给的（{@link WorkbenchError}）。认得的才放行：
	 * - 调用方放弃了：`aborted`；
	 * - 已经是助手服务自己的说法（期限、连不上、上面这些）：原样；
	 * - Agent 回了一个状态（`isWireError`）：应用层的那几种（{@link ANSWERS}）原话放行，命令超时换成 {@link TimeoutError}；
	 *   别的状态（Agent 内部出错、输出中断……）不放行原话，工作台是连得上的；
	 * - 其余的（连接层的失败，不论哪种错误码，含连接被重置、被中断、主机不可达；不是这个库的错误）：探一下，探不通就是
	 *   工作台连不上，探得通就是这一次调用出了问题。
	 * 不放行的原文只写进日志。
	 */
	const settle = async (
		error: unknown,
		what: string,
		outer: AbortSignal | undefined,
	): Promise<WorkbenchError> => {
		if (outer?.aborted) return new WorkbenchError("aborted");
		if (error instanceof WorkbenchError) return error;
		if (error instanceof ConnectError && error.isWireError) {
			if (error.code === Code.DeadlineExceeded && what === "命令") {
				return new TimeoutError(error.rawMessage);
			}
			if (ANSWERS.has(error.code)) return new AgentAnswer(error.code, error.rawMessage);
			log(`工作台 ${address} 回了这次${what}一个错误（${Code[error.code]}）：${error.rawMessage}`);
			return new WorkbenchError(
				`工作台没能完成这次${what}：它回了一个错误（工作台还连得上；原文只记在日志里）`,
			);
		}
		const raw = error instanceof ConnectError ? error.rawMessage : String(error);
		const ok = await reachable();
		log(`工作台 ${address} 这次${what}的连接出错${ok ? "（还探得通）" : "，之后也探不通"}：${raw}`);
		if (ok) {
			return new WorkbenchError(
				`工作台没能完成这次${what}：连接出了问题（工作台还连得上；原文只记在日志里）`,
			);
		}
		const why = /PING/i.test(raw) ? "保活的 ping 没有回应" : "连接断了";
		return new UnreachableError(`${WORKBENCH_UNREACHABLE}：${why}，之后也探不通`);
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
				throw new DeadlineError(what, Number((ms / 1000).toFixed(1)), await reachable());
			}
			throw await settle(error, what, outer);
		} finally {
			clearTimeout(timer);
		}
	}

	return {
		reachable,
		/** 关掉这条连接（连同上面还开着的调用）。用完就丢的客户端用它。 */
		close: () => connection.abort(),

		/** 执行一条命令（argv 不经 shell），返回退出码；超时抛 TimeoutError，调用方放弃时抛 "aborted"。 */
		run(argv: string[], options: ExecOptions): Promise<number> {
			const request = create(RunCommandRequestSchema, {
				argv,
				cwd: options.cwd,
				env: options.env ?? {},
				timeoutMs: BigInt(options.timeoutMs),
			});
			return withDeadline(
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
					throw new WorkbenchError("工作台没有返回这条命令的退出码");
				},
			);
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
					);
				}
				throw await settle(error, "读文件", signal);
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

/**
 * 把工作台这条连接上的错误换成和本地文件系统一样的说法（pi 的工具和模型都认 ENOENT 这类前缀）。传进来的是
 * {@link connectAgent} 抛出的错误（已经换过，见 `settle`）；不是 {@link WorkbenchError} 的不放行原文。
 */
export function asFsError(error: unknown, op: string, path: string): Error {
	if (error instanceof AgentAnswer) {
		if (error.code === Code.NotFound)
			return new Error(`ENOENT: no such file or directory, ${op} '${path}'`);
		if (error.code === Code.PermissionDenied)
			return new Error(`EACCES: permission denied, ${op} '${path}'`);
		if (error.code === Code.InvalidArgument && /目录/.test(error.message)) {
			return new Error(`EISDIR: illegal operation on a directory, ${op} '${path}'`);
		}
		return new Error(`${op} '${path}' 失败：${error.message}`);
	}
	if (error instanceof WorkbenchError) return error;
	return new Error(`${op} '${path}' 失败（助手服务内部出错）`);
}
