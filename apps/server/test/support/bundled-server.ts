import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import packageJson from "../../package.json" with { type: "json" };

/** 打包后的控制面（`pnpm bundle:server` 的产物 out/server/main.mjs）以子进程运行。 */
export interface BundledServer {
	readonly child: ChildProcess;
	readonly httpUrl: string;
	readonly grpcUrl: string;
	/** 进程的全部输出（失败时帮助定位）。 */
	readonly output: string[];
	/** SIGTERM 并等它退出。 */
	stop(): Promise<void>;
}

/**
 * 用 node 启动打包后的控制面，等它打印启动行。不设置目录类环境变量：验证单文件包自带的
 * web/、sdk/、drizzle/、docs/、agent/ 布局。端口默认随机（0）；给定端口时监听这些端口
 * （例如接替另一个控制面，让 Agent 按原地址重连）。
 */
export async function startBundledServer(options: {
	dir: string;
	databaseUrl: string;
	dataDir: string;
	ports?: { http: number; grpc: number };
}): Promise<BundledServer> {
	const child = spawn("node", ["--enable-source-maps", join(options.dir, "main.mjs")], {
		cwd: options.dataDir,
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			PATH: process.env.PATH,
			NODE_ENV: "production",
			DATABASE_URL: options.databaseUrl,
			SFLY_DATA_DIR: options.dataDir,
			SFLY_HTTP_HOST: "127.0.0.1",
			SFLY_HTTP_PORT: String(options.ports?.http ?? 0),
			SFLY_GRPC_HOST: "127.0.0.1",
			SFLY_GRPC_PORT: String(options.ports?.grpc ?? 0),
		},
	});
	const output: string[] = [];
	createInterface({ input: child.stderr as NodeJS.ReadableStream }).on("line", (l) =>
		output.push(l),
	);
	const stop = async () => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		const exited = new Promise((resolve) => child.once("exit", resolve));
		child.kill("SIGTERM");
		await exited;
	};
	const started = new RegExp(
		`^sfly control plane ${packageJson.version}: http (\\S+), grpc (\\S+)$`,
	);
	return new Promise<BundledServer>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`bundle did not start:\n${output.join("\n")}`)),
			30_000,
		);
		createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
			output.push(line);
			const match = started.exec(line);
			if (match) {
				clearTimeout(timer);
				resolve({
					child,
					httpUrl: match[1] as string,
					grpcUrl: match[2] as string,
					output,
					stop,
				});
			}
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`bundle exited with ${code}:\n${output.join("\n")}`));
		});
	});
}
