// 假的工作台：一个 Agent 能力端口（ADR 0019，proto/sfly/agent/v1/），h2c 上的 gRPC。默认在本机真的执行：
// 命令用 bash 跑（不经 shell 的 argv），文件读写落在测试自己建的临时目录里（工作区的路径就是这个临时目录）。
// `hostile` 打开时它对任何命令、任何读请求都返回给定的内容（测试远程工具扩展会不会被带偏）。记下收到的每个请求。
import { spawn } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import http2 from "node:http2";
import { type AddressInfo, connect, createServer, type Socket } from "node:net";
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
	readonly runs: Array<{
		argv: string[];
		cwd: string;
		env: Record<string, string>;
		timeoutMs: number;
	}> = [];
	readonly reads: string[] = [];
	readonly writes: Array<{ path: string; content: Buffer }> = [];
	hostile: Hostile | undefined;
	/**
	 * 命令里有这段文字时，这条命令一直不回话（像工作台卡住）；`thenSilent` 时从这以后所有调用都不回话
	 * （连 `describe` 也不回：像容器被暂停、网络断了却没关连接）。
	 */
	hang: { marker: string; thenSilent: boolean } | undefined;
	silent = false;
	/** 命令、读、写、查文件属性都回这个状态（`describe` 照常回：工作台连得上）。 */
	fail: { code: Code; message: string } | undefined;
	/** 照真的 Agent 的时序：命令超时之后先等这么久（SIGTERM 的宽限 + 等管道）才回复超时。 */
	timeoutReplyDelayMs = 0;

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

/** 一直不回话，直到调用方放弃。 */
function never(signal: AbortSignal): Promise<never> {
	return new Promise((_, reject) => {
		signal.addEventListener("abort", () => reject(new ConnectError("canceled", Code.Canceled)));
	});
}

function routes(router: ConnectRouter, workbench: () => FakeWorkbench): void {
	router.service(AgentPeer, {
		async describe(_req, ctx) {
			if (workbench().silent) await never(ctx.signal);
			return { name: "fake-workbench", agentVersion: "0.0.0", capabilities: [] };
		},
	});
	router.service(AgentExec, {
		async *run(req, ctx) {
			const wb = workbench();
			const env = Object.fromEntries(Object.entries(req.env));
			wb.runs.push({ argv: [...req.argv], cwd: req.cwd, env, timeoutMs: Number(req.timeoutMs) });
			failIfAsked(wb);
			if (wb.silent) await never(ctx.signal);
			if (wb.hang && req.argv.join(" ").includes(wb.hang.marker)) {
				if (wb.hang.thenSilent) wb.silent = true;
				await never(ctx.signal);
			}
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
						if (wb.timeoutReplyDelayMs > 0) {
							await new Promise((resolve) => setTimeout(resolve, wb.timeoutReplyDelayMs));
						}
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
		async *read(req, ctx) {
			const wb = workbench();
			wb.reads.push(req.path);
			failIfAsked(wb);
			if (wb.silent) await never(ctx.signal);
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
		async write(requests, ctx) {
			failIfAsked(workbench());
			if (workbench().silent) await never(ctx.signal);
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
		async stat(req, ctx) {
			const wb = workbench();
			failIfAsked(wb);
			if (wb.silent) await never(ctx.signal);
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

function failIfAsked(wb: FakeWorkbench): void {
	if (wb.fail) throw new ConnectError(wb.fail.message, wb.fail.code);
}

function output(data: Buffer, stream: OutputStream = OutputStream.STDOUT) {
	return { part: { case: "output" as const, value: { stream, data } } };
}

/** 一个只接受连接、从不回话的端口（不说 HTTP/2，也不关连接）：返回地址和关掉它的函数。 */
export async function silentPort(): Promise<{ address: string; close: () => Promise<void> }> {
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		address: `127.0.0.1:${(server.address() as AddressInfo).port}`,
		close: async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

/** 一个接了连接就重置的端口（RST）：返回地址和关掉它的函数。 */
export async function resettingPort(): Promise<{ address: string; close: () => Promise<void> }> {
	const server = createServer((socket) => socket.resetAndDestroy());
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		address: `127.0.0.1:${(server.address() as AddressInfo).port}`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

/**
 * 建连接时报的错（{@link AgentOptions.http2} 的 `createConnection`）：真的 TCP 套接字，在查地址这一步报给定的错，
 * 之后和真的连不上走同一条路。错误照 Node 的系统错误的样子（{@link systemError}），消息里有对端和本端的 IP 和端口
 * （macOS 上主机不可达就是这样：`connect EHOSTUNREACH 0.0.0.1:50052 - Local (192.168.31.169:53118)`）。
 * 主机不可达、网络不可达在各个系统上能造出来的地址不一样，测试里在建连接这一步造。
 */
export function failingConnection(error: Error): () => Socket {
	return () =>
		connect({
			host: "workbench.invalid",
			port: 50052,
			lookup: (_host, _options, callback) => setTimeout(() => callback(error, ""), 5),
		});
}

/** Node 的系统错误：`<调用> <错误码> <对端>[ - Local (<本端>)]`。 */
export function systemError(code: string, remote: string, local?: string): Error {
	const message = `connect ${code} ${remote}${local ? ` - Local (${local})` : ""}`;
	return Object.assign(new Error(message), { code, syscall: "connect" });
}

/**
 * 一个能冻住的 TCP 代理：平时把连接原样转发给 `target`；`freeze()` 之后两头都不再转发（收到的数据丢掉），也不关连接，
 * 新来的连接接下来但不转发（像工作台的容器被暂停、网络断了却没关连接）。
 */
export async function freezableProxy(target: string): Promise<{
	address: string;
	freeze: () => void;
	close: () => Promise<void>;
}> {
	const [host, port] = target.split(":") as [string, string];
	let frozen = false;
	const sockets = new Set<Socket>();
	const server = createServer((client) => {
		sockets.add(client);
		client.on("close", () => sockets.delete(client));
		client.on("error", () => {});
		if (frozen) return;
		const upstream = connect(Number(port), host);
		sockets.add(upstream);
		upstream.on("close", () => sockets.delete(upstream));
		upstream.on("error", () => client.destroy());
		client.on("data", (data) => {
			if (!frozen) upstream.write(data);
		});
		upstream.on("data", (data) => {
			if (!frozen) client.write(data);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		address: `127.0.0.1:${(server.address() as AddressInfo).port}`,
		freeze: () => {
			frozen = true;
		},
		close: async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
