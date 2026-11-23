import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const serverDir = join(import.meta.dirname, "..", "..");

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
		private readonly dataDir: string,
		private readonly auth: Record<string, string>,
		private readonly captured: { output: string },
		private readonly exited: Promise<ProcessExit>,
	) {
		void exited.then((exit) => {
			this.#exit = exit;
		});
	}

	static async start(
		databaseUrl: string,
		env: Record<string, string> = {},
	): Promise<ControlPlaneProcess> {
		const dataDir = await mkdtemp(join(tmpdir(), "sfly-cp-process-"));
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
				SFLY_HTTP_PORT: "0",
				SFLY_GRPC_PORT: "0",
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
				reject(new Error(`控制面启动时退出了：${captured.output}`));
			});
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
		await rm(this.dataDir, { recursive: true, force: true });
	}
}
