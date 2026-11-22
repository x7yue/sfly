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

export class TimeoutError extends Error {}

export interface ExecOptions {
	cwd: string;
	env?: Record<string, string>;
	timeoutMs: number;
	signal?: AbortSignal;
	onData?: (data: Uint8Array, stream: "stdout" | "stderr") => void;
}

export function connectAgent(address: string) {
	const transport = createGrpcTransport({ baseUrl: `http://${address}` });
	const exec = createClient(AgentExec, transport);
	const read = createClient(AgentFileRead, transport);
	const write = createClient(AgentFileWrite, transport);
	const files = createClient(AgentFiles, transport);
	const peer = createClient(AgentPeer, transport);

	return {
		describe: () => peer.describe({}),

		/** 执行一条命令（argv 不经 shell），返回退出码；超时抛 TimeoutError，调用方放弃时抛 "aborted"。 */
		async run(argv: string[], options: ExecOptions): Promise<number> {
			const request = create(RunCommandRequestSchema, {
				argv,
				cwd: options.cwd,
				env: options.env ?? {},
				timeoutMs: BigInt(options.timeoutMs),
			});
			try {
				for await (const response of exec.run(request, { signal: options.signal })) {
					if (response.part.case === "output") {
						const { stream, data } = response.part.value;
						options.onData?.(data, stream === OutputStream.STDERR ? "stderr" : "stdout");
					} else if (response.part.case === "exit") {
						return response.part.value.exitCode;
					}
				}
			} catch (error) {
				if (options.signal?.aborted) throw new Error("aborted");
				if (error instanceof ConnectError && error.code === Code.DeadlineExceeded) {
					throw new TimeoutError(error.rawMessage);
				}
				throw error;
			}
			throw new Error(`命令没有返回退出码：${argv.join(" ")}`);
		},

		async *readChunks(path: string, signal?: AbortSignal, length?: number) {
			for await (const response of read.read(
				{ path, length: length === undefined ? undefined : BigInt(length) },
				{ signal },
			)) {
				if (response.data.length > 0) yield response.data;
			}
		},

		async readFile(path: string): Promise<Buffer> {
			const parts: Uint8Array[] = [];
			for await (const chunk of this.readChunks(path)) parts.push(chunk);
			return Buffer.concat(parts);
		},

		stat: (path: string) => files.stat({ path }),

		async writeFile(path: string, content: Uint8Array): Promise<void> {
			async function* messages(): AsyncGenerator<WriteFileRequest> {
				yield create(WriteFileRequestSchema, { part: { case: "start", value: { path } } });
				for (let offset = 0; offset < content.length; offset += CHUNK) {
					yield create(WriteFileRequestSchema, {
						part: { case: "data", value: content.subarray(offset, offset + CHUNK) },
					});
				}
				yield create(WriteFileRequestSchema, {
					part: { case: "end", value: { size: BigInt(content.length) } },
				});
			}
			await write.write(messages());
		},
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
