// 假的工作台：一个 Agent 能力端口（ADR 0019，proto/sfly/agent/v1/），h2c 上的 gRPC。默认在本机真的执行：
// 命令用 bash 跑（不经 shell 的 argv），文件读写落在测试自己建的临时目录里（工作区的路径就是这个临时目录）。
// `hostile` 打开时它对任何命令、任何读请求都返回给定的内容（测试远程工具扩展会不会被带偏）。记下收到的每个请求。
import { spawn } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import {
	AgentExec,
	AgentFileRead,
	AgentFiles,
	AgentFileWrite,
	AgentPeer,
	OutputStream,
} from "@sfly/proto";

export interface Hostile {
	/** 每条命令的输出（退出码 0）。 */
	output: string;
	/** 每个读请求返回的内容。 */
	content: string;
}

export class FakeWorkbench {
	readonly runs: Array<{ argv: string[]; cwd: string; env: Record<string, string> }> = [];
	readonly reads: string[] = [];
	readonly writes: Array<{ path: string; content: Buffer }> = [];
	hostile: Hostile | undefined;

	private constructor(
		private readonly server: http2.Http2Server,
		private readonly sessions: Set<http2.ServerHttp2Session>,
		readonly address: string,
	) {}

	static async start(): Promise<FakeWorkbench> {
		let self: FakeWorkbench | undefined;
		const handler = connectNodeAdapter({
			routes: (router: ConnectRouter) => routes(router, () => self as FakeWorkbench),
		});
		const server = http2.createServer(handler);
		const sessions = new Set<http2.ServerHttp2Session>();
		server.on("session", (session) => {
			sessions.add(session);
			session.on("close", () => sessions.delete(session));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		self = new FakeWorkbench(
			server,
			sessions,
			`127.0.0.1:${(server.address() as AddressInfo).port}`,
		);
		return self;
	}

	async close(): Promise<void> {
		const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
		for (const session of this.sessions) session.destroy();
		await closed;
	}
}

function routes(router: ConnectRouter, workbench: () => FakeWorkbench): void {
	router.service(AgentPeer, {
		describe: () => ({ name: "fake-workbench", agentVersion: "0.0.0", capabilities: [] }),
	});
	router.service(AgentExec, {
		async *run(req, ctx) {
			const wb = workbench();
			const env = Object.fromEntries(Object.entries(req.env));
			wb.runs.push({ argv: [...req.argv], cwd: req.cwd, env });
			if (wb.hostile) {
				yield output(Buffer.from(wb.hostile.output));
				yield { part: { case: "exit" as const, value: { exitCode: 0 } } };
				return;
			}
			const [command, ...args] = req.argv;
			const child = spawn(command as string, args, {
				cwd: req.cwd,
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: req.cwd, ...env },
				detached: true,
			});
			const queue: Array<{ data?: Buffer; stream?: OutputStream; exit?: number }> = [];
			let wake: (() => void) | undefined;
			const push = (item: (typeof queue)[number]) => {
				queue.push(item);
				wake?.();
			};
			child.stdout.on("data", (data: Buffer) => push({ data, stream: OutputStream.STDOUT }));
			child.stderr.on("data", (data: Buffer) => push({ data, stream: OutputStream.STDERR }));
			child.on("close", (code) => push({ exit: code ?? -1 }));
			const kill = () => {
				try {
					process.kill(-(child.pid as number), "SIGKILL");
				} catch {}
			};
			const timeout = setTimeout(() => {
				kill();
				push({ exit: -2 });
			}, Number(req.timeoutMs));
			ctx.signal.addEventListener("abort", kill);
			try {
				while (true) {
					const item = queue.shift();
					if (!item) {
						await new Promise<void>((resolve) => {
							wake = resolve;
						});
						continue;
					}
					if (item.exit === -2) {
						throw new ConnectError("timeout", Code.DeadlineExceeded);
					}
					if (item.exit !== undefined) {
						yield { part: { case: "exit" as const, value: { exitCode: item.exit } } };
						return;
					}
					yield output(item.data as Buffer, item.stream);
				}
			} finally {
				clearTimeout(timeout);
				kill();
			}
		},
	});
	router.service(AgentFileRead, {
		async *read(req) {
			const wb = workbench();
			wb.reads.push(req.path);
			if (wb.hostile) {
				yield { data: Buffer.from(wb.hostile.content) };
				return;
			}
			let data: Buffer;
			try {
				data = await readFile(req.path);
			} catch {
				throw new ConnectError(`没有 ${req.path}`, Code.NotFound);
			}
			const length = req.length === undefined ? data.length : Number(req.length);
			yield { data: data.subarray(Number(req.offset), Number(req.offset) + length) };
		},
	});
	router.service(AgentFileWrite, {
		async write(requests) {
			let path = "";
			const parts: Buffer[] = [];
			for await (const req of requests) {
				if (req.part.case === "start") path = req.part.value.path;
				if (req.part.case === "data") parts.push(Buffer.from(req.part.value));
			}
			const content = Buffer.concat(parts);
			workbench().writes.push({ path, content });
			try {
				await writeFile(path, content);
			} catch {
				throw new ConnectError(`写不了 ${path}`, Code.NotFound);
			}
			return {};
		},
		delete: () => ({}),
	});
	router.service(AgentFiles, {
		async *list() {},
		async stat(req) {
			const wb = workbench();
			if (wb.hostile) return { file: { path: req.path, size: 1n } };
			try {
				const info = await stat(req.path);
				return { file: { path: req.path, size: BigInt(info.size) } };
			} catch {
				throw new ConnectError(`没有 ${req.path}`, Code.NotFound);
			}
		},
	});
}

function output(data: Buffer, stream: OutputStream = OutputStream.STDOUT) {
	return { part: { case: "output" as const, value: { stream, data } } };
}
