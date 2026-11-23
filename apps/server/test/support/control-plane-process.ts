import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const serverDir = join(import.meta.dirname, "..", "..");

/** 控制面在启动完成之前就退出了（连不上数据库、迁移出错……）；`output` 是它到那时为止写的全部输出。 */
export class StartupExitError extends Error {
	constructor(readonly output: string) {
		super(`控制面启动时退出了：${output}`);
		this.name = "StartupExitError";
	}
}

/** 控制面进程的退出信息。 */
export interface ProcessExit {
	code: number | null;
	signal: string | null;
}

/**
 * 一个真实的控制面**进程**（`node --import tsx src/main.ts`，和 `pnpm start` 一样从源码运行，生产环境变量）：
 * 进程崩溃（未捕获的异常、未处理的拒绝）在测试进程里看不出来，只有起一个进程才能断言「进程没有退出」。
 * 用初始管理员 root 登录，`request` 带登录 Cookie；HTTP、gRPC 监听随机端口。
 */
export class ControlPlaneProcess {
	#exit: ProcessExit | undefined;

	private constructor(
		private readonly child: ChildProcess,
		readonly httpUrl: string,
		readonly grpcUrl: string,
		/** 数据目录；自己建的在 `stop()` 时删掉，传进来的（要用同一个数据目录重新起）由调用方删。 */
		readonly dataDir: string,
		private readonly ownsDataDir: boolean,
		private readonly auth: Record<string, string>,
		private readonly captured: { output: string },
		private readonly exited: Promise<ProcessExit>,
	) {
		void exited.then((exit) => {
			this.#exit = exit;
		});
	}

	/**
	 * `env` 覆盖默认的环境变量；`options.dataDir` 给了就用它（同一个数据目录和库重新起一个，模拟重启策略把退出的控制面拉起来），
	 * 并且 `stop()` 不删它；`options.ports` 给了就监听这两个端口（真实的 Agent 按原来的地址重连要用）。
	 */
	static async start(
		databaseUrl: string,
		env: Record<string, string> = {},
		options: { dataDir?: string; ports?: { http: number; grpc: number } } = {},
	): Promise<ControlPlaneProcess> {
		const ownsDataDir = options.dataDir === undefined;
		const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), "sfly-cp-process-")));
		const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
			cwd: serverDir,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: process.env.HOME ?? "",
				NODE_ENV: "production",
				DATABASE_URL: databaseUrl,
				SFLY_DATA_DIR: dataDir,
				SFLY_HTTP_HOST: "127.0.0.1",
				SFLY_GRPC_HOST: "127.0.0.1",
				SFLY_HTTP_PORT: String(options.ports?.http ?? 0),
				SFLY_GRPC_PORT: String(options.ports?.grpc ?? 0),
				SFLY_ADMIN_LOGIN: "root",
				SFLY_ADMIN_PASSWORD: "admin-password-1",
				...env,
			},
		});
		const captured = { output: "" };
		for (const stream of [child.stdout, child.stderr]) {
			stream?.on("data", (chunk) => {
				captured.output += String(chunk);
			});
		}
		const exited = new Promise<ProcessExit>((resolve) =>
			child.once("exit", (code, signal) => resolve({ code, signal })),
		);
		const urls = await new Promise<{ http: string; grpc: string }>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`控制面没有在 60 秒内启动：${captured.output}`)),
				60_000,
			);
			const check = setInterval(() => {
				const found = /http (http:\/\/[^,\s]+), grpc (http:\/\/[^,\s]+)/.exec(captured.output);
				if (found?.[1] && found[2]) {
					clearTimeout(timer);
					clearInterval(check);
					resolve({ http: found[1], grpc: found[2] });
				}
			}, 100);
			void exited.then(() => {
				clearTimeout(timer);
				clearInterval(check);
				reject(new StartupExitError(captured.output));
			});
		}).catch(async (error: unknown) => {
			// 没有起来：杀掉进程，自己建的数据目录也删掉。
			child.kill("SIGKILL");
			await exited;
			if (ownsDataDir) await rm(dataDir, { recursive: true, force: true });
			throw error;
		});
		const login = await fetch(`${urls.http}/auth/login`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ login_name: "root", password: "admin-password-1" }),
		});
		const cookie = /sfly_login=([^;]*)/.exec(login.headers.get("set-cookie") ?? "")?.[1] ?? "";
		return new ControlPlaneProcess(
			child,
			urls.http,
			urls.grpc,
			dataDir,
			ownsDataDir,
			{ cookie: `sfly_login=${cookie}`, "sec-fetch-site": "same-origin" },
			captured,
			exited,
		);
	}

	/** 到现在为止控制面写到标准输出和标准错误的全部内容。 */
	get log(): string {
		return this.captured.output;
	}

	/** 进程退出了吗：退出了是退出信息，还活着是 undefined。 */
	get exit(): ProcessExit | undefined {
		return this.#exit;
	}

	/** 等进程退出，最多 `ms` 毫秒；没退出返回 undefined。 */
	async waitForExit(ms: number): Promise<ProcessExit | undefined> {
		return Promise.race([
			this.exited,
			new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
		]);
	}

	/** 带登录 Cookie 的请求（和 `TestControlPlane.fetch` 同样的形状，可以传给测试里发布节点包等辅助函数）。 */
	fetch(path: string, init: RequestInit = {}): Promise<Response> {
		return fetch(`${this.httpUrl}${path}`, {
			...init,
			headers: { ...this.auth, ...(init.headers as Record<string, string> | undefined) },
		});
	}

	/** 带登录 Cookie 的请求；`body` 给了就当 JSON 发。 */
	request(method: string, path: string, body?: unknown): Promise<Response> {
		return this.fetch(path, {
			method,
			...(body === undefined
				? {}
				: { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
		});
	}

	async stop(): Promise<void> {
		this.child.kill("SIGKILL");
		await this.exited;
		if (this.ownsDataDir) await rm(this.dataDir, { recursive: true, force: true });
	}
}
