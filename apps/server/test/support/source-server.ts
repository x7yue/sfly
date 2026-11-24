import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import packageJson from "../../package.json" with { type: "json" };

const serverDir = join(import.meta.dirname, "..", "..");

/** 控制面以单独的进程运行（和 `pnpm start` 一样：tsx 运行 `src/main.ts`），测试能看到进程退出、退出码和它写的日志。 */
export interface SourceServer {
	readonly child: ChildProcess;
	readonly httpUrl: string;
	readonly grpcUrl: string;
	/** 进程的全部输出（标准输出和标准错误，按行，先后按到达的顺序）。 */
	readonly output: string[];
	/** 进程退出时的退出码和信号；还没退出时为 undefined。 */
	readonly exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
	/** 等进程退出（已经退出的立即返回）。 */
	exited(timeoutMs?: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	/** 对 HTTP API 发请求，path 以 / 开头。 */
	fetch(path: string, init?: RequestInit): Promise<Response>;
	/** SIGTERM 并等它退出（已经退出的什么也不做）。 */
	stop(): Promise<void>;
}

/** 启动 `src/main.ts`，等它打印启动行。端口随机；只监听本机。 */
export async function startSourceServer(options: {
	databaseUrl: string;
	dataDir: string;
	env?: Record<string, string>;
}): Promise<SourceServer> {
	const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
		cwd: serverDir,
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			PATH: process.env.PATH ?? "",
			HOME: process.env.HOME ?? "",
			...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
			DATABASE_URL: options.databaseUrl,
			SFLY_DATA_DIR: options.dataDir,
			SFLY_HTTP_HOST: "127.0.0.1",
			SFLY_HTTP_PORT: "0",
			SFLY_GRPC_HOST: "127.0.0.1",
			SFLY_GRPC_PORT: "0",
			...options.env,
		},
	});
	const output: string[] = [];
	let exit: SourceServer["exit"];
	const exitWaiters: Array<(value: NonNullable<SourceServer["exit"]>) => void> = [];
	// 用 `close` 而不是 `exit`：进程退出之后它的标准输出标准错误还可能有没读完的，`close` 是它们都读完之后，这时 `output` 才是完整的。
	child.once("close", (code, signal) => {
		exit = { code, signal };
		for (const waiter of exitWaiters) waiter(exit);
	});
	for (const stream of [child.stdout, child.stderr]) {
		createInterface({ input: stream as NodeJS.ReadableStream }).on("line", (line) =>
			output.push(line),
		);
	}
	const exited: SourceServer["exited"] = (timeoutMs = 30_000) =>
		exit
			? Promise.resolve(exit)
			: new Promise((resolve, reject) => {
					const timer = setTimeout(
						() => reject(new Error(`进程 ${timeoutMs} 毫秒内没有退出：\n${output.join("\n")}`)),
						timeoutMs,
					);
					exitWaiters.push((value) => {
						clearTimeout(timer);
						resolve(value);
					});
				});
	const started = new RegExp(
		`^sfly control plane ${packageJson.version}: http (\\S+), grpc (\\S+)$`,
	);
	const urls = await new Promise<{ http: string; grpc: string }>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`控制面 60 秒内没有启动：\n${output.join("\n")}`)),
			60_000,
		);
		const poll = setInterval(() => {
			for (const line of output) {
				const match = started.exec(line);
				if (match) {
					clearTimeout(timer);
					clearInterval(poll);
					resolve({ http: match[1] as string, grpc: match[2] as string });
					return;
				}
			}
			if (exit) {
				clearTimeout(timer);
				clearInterval(poll);
				reject(new Error(`控制面启动时退出了（${JSON.stringify(exit)}）：\n${output.join("\n")}`));
			}
		}, 50);
	});
	return {
		child,
		httpUrl: urls.http,
		grpcUrl: urls.grpc,
		output,
		get exit() {
			return exit;
		},
		exited,
		fetch: (path, init) => fetch(`${urls.http}${path}`, init),
		stop: async () => {
			if (exit) return;
			child.kill("SIGTERM");
			await exited();
		},
	};
}
