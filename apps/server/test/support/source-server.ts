import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import packageJson from "../../package.json" with { type: "json" };

const serverDir = join(import.meta.dirname, "..", "..");

/** 控制面在启动完成之前就退出了（连不上数据库、迁移出错……）；`output` 是它到那时为止写的全部输出。 */
export class StartupExitError extends Error {
	constructor(readonly output: string) {
		super(`控制面启动时退出了：${output}`);
		this.name = "StartupExitError";
	}
}

/** 进程的退出信息。 */
export interface ProcessExit {
	code: number | null;
	signal: NodeJS.Signals | null;
}

/**
 * 控制面以单独的进程运行（和 `pnpm start` 一样：tsx 运行 `src/main.ts`），测试能看到进程退出、退出码和它写的日志。
 * 进程崩溃（未捕获的异常、未处理的拒绝）、因错误而有序退出、收到停止信号时的退出码，在测试进程里看不出来，只有起一个进程才能断言。
 * 这是唯一的「起 `main.ts` 子进程」的测试工具（#563 的 `ControlPlaneProcess` 和 #661 的 `startSourceServer` 合成一份）。
 */
export interface SourceServer {
	readonly child: ChildProcess;
	readonly httpUrl: string;
	readonly grpcUrl: string;
	/** 数据目录；自己建的在 `stop()`、`kill()` 时删掉，传进来的（要用同一个数据目录重新起）由调用方删。 */
	readonly dataDir: string;
	/** 进程的全部输出（标准输出和标准错误，按行，先后按到达的顺序）。 */
	readonly output: string[];
	/** 到现在为止的全部输出连成一个字符串（按行用换行连接）。 */
	readonly log: string;
	/** 进程退出时的退出码和信号；还没退出时为 undefined。 */
	readonly exit: ProcessExit | undefined;
	/** 等进程退出（已经退出的立即返回）；`timeoutMs` 内没有退出就拒绝，说明里附上输出。 */
	exited(timeoutMs?: number): Promise<ProcessExit>;
	/** 等进程退出，最多 `ms` 毫秒；没退出返回 undefined。 */
	waitForExit(ms: number): Promise<ProcessExit | undefined>;
	/** 对 HTTP API 发请求，path 以 / 开头；用 `admin: true` 起的带初始管理员的登录 Cookie。 */
	fetch(path: string, init?: RequestInit): Promise<Response>;
	/** 同 `fetch`；`body` 给了就当 JSON 发。 */
	request(method: string, path: string, body?: unknown): Promise<Response>;
	/** SIGTERM 并等它退出（已经退出的什么也不做）：正常的停止，走有序关闭。 */
	stop(): Promise<void>;
	/** SIGKILL 并等它退出（清理用，不等关闭）。 */
	kill(): Promise<void>;
}

/** 启动 `src/main.ts`，等它打印启动行。默认端口随机、只监听本机。 */
export async function startSourceServer(options: {
	databaseUrl: string;
	/** 数据目录；不给就建一个临时的（`stop()`、`kill()` 时删）。 */
	dataDir?: string;
	env?: Record<string, string>;
	/** 监听这两个端口（真实的 Agent 按原来的地址重连要用）。 */
	ports?: { http: number; grpc: number };
	/** 设初始管理员 root（`SFLY_ADMIN_LOGIN`、`SFLY_ADMIN_PASSWORD`）并登录，之后 `fetch`、`request` 带登录 Cookie。 */
	admin?: boolean;
	/** `NODE_ENV=production`（生产环境变量）。 */
	production?: boolean;
}): Promise<SourceServer> {
	const ownsDataDir = options.dataDir === undefined;
	const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), "sfly-source-server-")));
	const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
		cwd: serverDir,
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			PATH: process.env.PATH ?? "",
			HOME: process.env.HOME ?? "",
			...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
			...(options.production ? { NODE_ENV: "production" } : {}),
			DATABASE_URL: options.databaseUrl,
			SFLY_DATA_DIR: dataDir,
			SFLY_HTTP_HOST: "127.0.0.1",
			SFLY_HTTP_PORT: String(options.ports?.http ?? 0),
			SFLY_GRPC_HOST: "127.0.0.1",
			SFLY_GRPC_PORT: String(options.ports?.grpc ?? 0),
			...(options.admin
				? { SFLY_ADMIN_LOGIN: "root", SFLY_ADMIN_PASSWORD: "admin-password-1" }
				: {}),
			...options.env,
		},
	});
	const output: string[] = [];
	let exit: ProcessExit | undefined;
	const exitWaiters: Array<(value: ProcessExit) => void> = [];
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
	const waitForExit: SourceServer["waitForExit"] = (ms) =>
		exit
			? Promise.resolve(exit)
			: new Promise((resolve) => {
					const timer = setTimeout(() => resolve(undefined), ms);
					exitWaiters.push((value) => {
						clearTimeout(timer);
						resolve(value);
					});
				});
	const cleanup = async () => {
		if (ownsDataDir) await rm(dataDir, { recursive: true, force: true });
	};
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
				reject(new StartupExitError(output.join("\n")));
			}
		}, 50);
	}).catch(async (error: unknown) => {
		// 没有起来：杀掉进程，自己建的数据目录也删掉。
		child.kill("SIGKILL");
		await exited().catch(() => undefined);
		await cleanup();
		throw error;
	});
	const auth: Record<string, string> = {};
	if (options.admin) {
		const login = await fetch(`${urls.http}/auth/login`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ login_name: "root", password: "admin-password-1" }),
		});
		const cookie = /sfly_login=([^;]*)/.exec(login.headers.get("set-cookie") ?? "")?.[1] ?? "";
		auth.cookie = `sfly_login=${cookie}`;
		auth["sec-fetch-site"] = "same-origin";
	}
	const fetchWithAuth: SourceServer["fetch"] = (path, init = {}) =>
		fetch(`${urls.http}${path}`, {
			...init,
			headers: { ...auth, ...(init.headers as Record<string, string> | undefined) },
		});
	return {
		child,
		httpUrl: urls.http,
		grpcUrl: urls.grpc,
		dataDir,
		output,
		get log() {
			return output.join("\n");
		},
		get exit() {
			return exit;
		},
		exited,
		waitForExit,
		fetch: fetchWithAuth,
		request: (method, path, body) =>
			fetchWithAuth(path, {
				method,
				...(body === undefined
					? {}
					: { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
			}),
		stop: async () => {
			if (!exit) {
				child.kill("SIGTERM");
				await exited();
			}
			await cleanup();
		},
		kill: async () => {
			if (!exit) {
				child.kill("SIGKILL");
				await exited();
			}
			await cleanup();
		},
	};
}
