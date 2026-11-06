import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { agentBinary, repoRoot } from "./agent-binary.js";

/** 以子进程运行的真实 Rust Agent。标准输出是 JSON 事件流，标准错误直接透传。 */
export interface RealAgent {
	readonly child: ChildProcess;
	/** 任务工作目录的根目录（临时目录，close() 时删除）。 */
	readonly workDir: string;
	/** 已收到的标准输出事件。 */
	readonly events: Array<Record<string, unknown>>;
	close(): Promise<void>;
}

/** 启动真实 Agent 并等到它第一次连上控制面（输出 welcome 事件）。 */
export async function startRealAgent(options: {
	grpcUrl: string;
	name: string;
	/** 共享 venv；不传时指向一个不存在的目录（Agent 启动时用 uv 创建一个空 venv）。 */
	venv?: string;
	args?: string[];
	bin?: string;
	/** 追加的环境变量（例如独立的 UV_CACHE_DIR）。 */
	env?: Record<string, string>;
	/** 等 welcome 的时间，默认 15 秒；包括创建 venv 和安装 SDK 运行时（它们在连上控制面之后、welcome 事件之前完成）。 */
	welcomeTimeoutMs?: number;
}): Promise<RealAgent> {
	const bin = options.bin ?? agentBinary();
	const workDir = await mkdtemp(join(tmpdir(), "sfly-agent-work-"));
	const child = spawn(
		bin,
		[
			"--server",
			options.grpcUrl,
			"--name",
			options.name,
			"--venv",
			options.venv ?? join(workDir, "no-venv"),
			"--work-dir",
			join(workDir, "tasks"),
			...(options.args ?? []),
		],
		{
			stdio: ["ignore", "pipe", "inherit"],
			// 独立的 SFLY_HOME：不读开发者自己的 ~/.sfly/agent.env。
			env: { ...process.env, SFLY_HOME: join(workDir, "sfly-home"), ...options.env },
		},
	);
	const events: Array<Record<string, unknown>> = [];
	const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream });
	const close = async () => {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = new Promise((resolve) => child.once("exit", resolve));
			child.kill("SIGKILL");
			await exited;
		}
		await rm(workDir, { recursive: true, force: true });
	};
	try {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("agent did not report welcome")),
				options.welcomeTimeoutMs ?? 15_000,
			);
			lines.on("line", (line) => {
				const event = JSON.parse(line) as Record<string, unknown>;
				events.push(event);
				if (event.event === "welcome") {
					clearTimeout(timer);
					resolve();
				}
			});
			child.once("exit", (code) => reject(new Error(`agent exited early with ${code}`)));
		});
	} catch (error) {
		await close();
		throw error;
	}
	return { child, workDir, events, close };
}

/**
 * 装好 SDK 运行时和桩节点包 sfly-stub@0.1.0（testdata/stub-package）的共享 venv；
 * `sdkOnly` 时只装 SDK 运行时（节点包由 Agent 从控制面下载安装）。
 */
export async function createStubVenv(
	options: { sdkOnly?: boolean } = {},
): Promise<{ path: string; remove(): Promise<void> }> {
	const dir = await mkdtemp(join(tmpdir(), "sfly-stub-venv-"));
	const path = join(dir, "venv");
	const args = options.sdkOnly ? [path, "--sdk-only"] : [path];
	await promisify(execFile)(join(repoRoot, "scripts", "stub-venv.sh"), args, { cwd: repoRoot });
	return { path, remove: () => rm(dir, { recursive: true, force: true }) };
}
