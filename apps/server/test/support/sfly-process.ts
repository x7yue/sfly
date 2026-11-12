import { spawn } from "node:child_process";
import {
	cleanEnv,
	repoRoot,
	type SflyOptions,
	type SflyResult,
	withoutUvNoise,
} from "./sfly-cli.js";

export interface SflyProcess {
	readonly stdout: string;
	readonly stderr: string;
	/** 等 stderr 里出现这段文字（命令行写进度、提示的时机）。 */
	waitForStderr(text: string, timeoutMs?: number): Promise<void>;
	/** 像终端里按 Ctrl-C：给命令所在的整个进程组发 SIGINT。 */
	interrupt(): void;
	/** 命令结束后的退出码和输出；被信号杀死时退出码是 128 加信号编号。 */
	readonly exited: Promise<SflyResult>;
	/** 强制结束整个进程组（测试收尾用）。 */
	kill(): void;
}

/**
 * 启动真实的 `sfly` 进程但不等它结束：测试可以在它运行时观察输出、按 Ctrl-C。
 * 进程放在自己的进程组里，`interrupt()` 与终端按 Ctrl-C 一样发给整个进程组（`uv run` 和命令本身）。
 */
export function spawnSfly(args: string[], options: SflyOptions = {}): SflyProcess {
	const env = { ...cleanEnv(), ...options.env };
	for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
	const child = spawn("uv", ["run", "--locked", "sfly", ...args], {
		cwd: options.cwd ?? repoRoot,
		env: env as NodeJS.ProcessEnv,
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	const watchers = new Set<() => void>();
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk;
		for (const watcher of [...watchers]) watcher();
	});
	const signalGroup = (signal: NodeJS.Signals) => {
		try {
			if (child.pid !== undefined) process.kill(-child.pid, signal);
		} catch {
			// 进程组已经结束。
		}
	};
	const exited = new Promise<SflyResult>((resolve) => {
		child.on("close", (code, signal) => {
			const exit = code ?? (signal ? 128 + (signalNumber[signal] ?? 0) : -1);
			resolve({ code: exit, stdout, stderr: withoutUvNoise(stderr) });
		});
	});
	return {
		get stdout() {
			return stdout;
		},
		get stderr() {
			return stderr;
		},
		waitForStderr(text, timeoutMs = 20_000) {
			return new Promise<void>((resolve, reject) => {
				const check = () => {
					if (!stderr.includes(text)) return;
					clearTimeout(timer);
					watchers.delete(check);
					resolve();
				};
				const timer = setTimeout(() => {
					watchers.delete(check);
					reject(new Error(`stderr 里没有出现 ${JSON.stringify(text)}，目前是：\n${stderr}`));
				}, timeoutMs);
				watchers.add(check);
				check();
			});
		},
		interrupt: () => signalGroup("SIGINT"),
		exited,
		kill: () => signalGroup("SIGKILL"),
	};
}

const signalNumber: Record<string, number> = { SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };
