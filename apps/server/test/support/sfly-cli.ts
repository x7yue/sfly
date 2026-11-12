import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const execFileAsync = promisify(execFile);

export interface SflyResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface SflyOptions {
	/** 在干净环境之上追加或覆盖的环境变量；值为 undefined 表示去掉。 */
	env?: Record<string, string | undefined>;
	cwd?: string;
}

/** 没有 agent.env 的空 SFLY_HOME：测试里的命令不读开发机上真实的 ~/.sfly。 */
const emptyHome = mkdtempSync(join(tmpdir(), "sfly-home-"));

/**
 * 继承的环境变量里，会影响命令行取值的都去掉：SFLY_*（地址、昵称、SFLY_HOME）、
 * AI 编程助手的标记（AI_AGENT、CLAUDECODE、CODEX_*，测试可能就跑在 AI 编程助手里）。
 */
function cleanEnv(): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith("SFLY_") || key.startsWith("CODEX_")) continue;
		if (key === "AI_AGENT" || key === "CLAUDECODE") continue;
		env[key] = value;
	}
	return { ...env, SFLY_HOME: emptyHome };
}

/** 运行真实的 `sfly` 命令行进程（uv 运行），返回退出码、stdout 和 stderr。 */
export async function sfly(args: string[], options: SflyOptions = {}): Promise<SflyResult> {
	const env = { ...cleanEnv(), ...options.env };
	for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
	try {
		const { stdout, stderr } = await execFileAsync("uv", ["run", "--locked", "sfly", ...args], {
			cwd: options.cwd ?? repoRoot,
			env: env as NodeJS.ProcessEnv,
		});
		return { code: 0, stdout, stderr: withoutUvNoise(stderr) };
	} catch (error) {
		const e = error as { code?: number; stdout?: string; stderr?: string };
		return { code: e.code ?? -1, stdout: e.stdout ?? "", stderr: withoutUvNoise(e.stderr ?? "") };
	}
}

/** 并发跑测试时 uv 可能在 stderr 打等待锁的提示，那不是命令行的输出。 */
function withoutUvNoise(stderr: string): string {
	return stderr
		.split("\n")
		.filter((line) => !line.startsWith("Blocking waiting for file lock"))
		.join("\n");
}
