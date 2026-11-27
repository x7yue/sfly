import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { DISPLAY_NAME_MAX_LENGTH, nameProblem } from "@sfly/schema";

export const repoRoot = resolve(import.meta.dirname, "../../../..");
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
export function cleanEnv(): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith("SFLY_") || key.startsWith("CODEX_")) continue;
		if (key === "AI_AGENT" || key === "CLAUDECODE") continue;
		env[key] = value;
	}
	return { ...env, SFLY_HOME: emptyHome };
}

/**
 * 测试控制面的地址 → 按昵称给出个人令牌（#493，`TestControlPlane` 启动时登记）：命令行连这个地址时默认带上
 * `SFLY_API_TOKEN`，和 `TestControlPlane.fetch` 默认带凭据一样。昵称取 `SFLY_NICKNAME`，没有时是 `tester`；
 * 令牌是那个昵称的用户的（`TestUsers`），第一次用到时建出来。
 */
export interface CliCredentials {
	/** 这个昵称的令牌（没有就建）；控制面不带默认凭据时为 undefined。 */
	token(nickname: string | undefined): Promise<string | undefined>;
	/** 已经建出来的令牌（同步，`spawnSfly` 用）。 */
	tokenNow(nickname: string | undefined): string | undefined;
}

const cliCredentials = new Map<string, CliCredentials>();

export function registerCliCredentials(httpUrl: string, credentials: CliCredentials): () => void {
	cliCredentials.set(httpUrl, credentials);
	return () => {
		if (cliCredentials.get(httpUrl) === credentials) cliCredentials.delete(httpUrl);
	};
}

/**
 * 代理的地址：命令行经代理连测试控制面时，和直接连一样带上它的默认凭据（代理的辅助启动时登记，tcp-proxy.ts 等）。
 * `target` 没有登记过（代理连的不是测试控制面）时什么都不做。
 */
export function aliasCliServer(proxyUrl: string, target: string): void {
	const credentials = cliCredentials.get(target.replace(/\/+$/, ""));
	if (credentials !== undefined) cliCredentials.set(proxyUrl, credentials);
}

/** 命令连的控制面：`--server` 参数或 `SFLY_SERVER`。 */
function serverOf(
	args: readonly string[],
	env: Record<string, string | undefined>,
): string | undefined {
	const flag = args.indexOf("--server");
	if (flag >= 0) return args[flag + 1];
	const inline = args.find((arg) => arg.startsWith("--server="));
	return inline?.slice("--server=".length) ?? env.SFLY_SERVER;
}

/** 命令里的昵称：`--nickname` 参数或 `SFLY_NICKNAME`；去掉它之后的参数。 */
function nicknameOf(
	args: readonly string[],
	env: Record<string, string | undefined>,
): { nickname: string | undefined; rest: string[] } {
	const flag = args.indexOf("--nickname");
	if (flag >= 0) {
		return { nickname: args[flag + 1], rest: [...args.slice(0, flag), ...args.slice(flag + 2)] };
	}
	const inline = args.findIndex((arg) => arg.startsWith("--nickname="));
	if (inline >= 0) {
		return {
			nickname: args[inline]?.slice("--nickname=".length),
			rest: args.filter((_, i) => i !== inline),
		};
	}
	return { nickname: env.SFLY_NICKNAME, rest: [...args] };
}

/**
 * 能当用户的显示名的昵称：空的、太长的、带控制字符等不合格的不行（命令行会拒绝它，测的就是这个），这时不带默认的凭据。
 * 没写昵称（undefined）是 tester。
 */
export function usableNickname(nickname: string | undefined): boolean {
	if (nickname === undefined) return true;
	const trimmed = nickname.trim();
	return (
		trimmed !== "" &&
		trimmed === nickname &&
		nickname.length <= DISPLAY_NAME_MAX_LENGTH &&
		nameProblem(nickname) === undefined
	);
}

/**
 * 命令的参数和环境：干净环境，加上调用方给的；连的是登记过的测试控制面时，带上昵称的那个用户的个人令牌
 * （`SFLY_API_TOKEN`），并去掉昵称（`--nickname`、`SFLY_NICKNAME`）：有令牌时身份由令牌决定，命令行会提示昵称被忽略。
 * 用户的显示名就是昵称，记下的名字和只带昵称时一样。调用方写了 `SFLY_API_TOKEN`（值为 undefined 也算）时什么都不动，
 * 要测不带凭据或昵称本身的命令就这样写。`token` 给出连的控制面上这个昵称的令牌。
 */
function prepare(
	args: readonly string[],
	options: SflyOptions,
	token: (credentials: CliCredentials, nickname: string | undefined) => string | undefined,
): { args: string[]; env: Record<string, string> } {
	const env = { ...cleanEnv(), ...options.env };
	let finalArgs = [...args];
	if (!(options.env && "SFLY_API_TOKEN" in options.env)) {
		const server = serverOf(args, env);
		const credentials =
			server === undefined ? undefined : cliCredentials.get(server.replace(/\/+$/, ""));
		if (credentials !== undefined) {
			const { nickname, rest } = nicknameOf(args, env);
			const found = token(credentials, nickname);
			if (found) {
				env.SFLY_API_TOKEN = found;
				env.SFLY_NICKNAME = undefined;
				finalArgs = rest;
			}
		}
	}
	for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
	return { args: finalArgs, env: env as Record<string, string> };
}

/** {@link prepare}：令牌没有就建。 */
async function cliCall(
	args: readonly string[],
	options: SflyOptions,
): Promise<{ args: string[]; env: Record<string, string> }> {
	const env = { ...cleanEnv(), ...options.env };
	const server = serverOf(args, env);
	const credentials =
		server === undefined ? undefined : cliCredentials.get(server.replace(/\/+$/, ""));
	const nickname = nicknameOf(args, env).nickname;
	const token =
		credentials === undefined ||
		(options.env && "SFLY_API_TOKEN" in options.env) ||
		!usableNickname(nickname)
			? undefined
			: await credentials.token(nickname);
	return prepare(args, options, () => token);
}

/** {@link prepare}，同步：令牌要已经建出来（先 `await cp.users.user(昵称)`，tester 是 `cp.users.user()`）。 */
export function cliCallNow(
	args: readonly string[],
	options: SflyOptions,
): { args: string[]; env: Record<string, string> } {
	return prepare(args, options, (credentials, nickname) => {
		if (!usableNickname(nickname)) return undefined;
		const token = credentials.tokenNow(nickname);
		if (token === undefined) {
			throw new Error(
				`测试控制面还没有昵称 ${nickname} 的令牌：先 await cp.users.user(${JSON.stringify(nickname)})`,
			);
		}
		return token;
	});
}

/** 运行真实的 `sfly` 命令行进程（uv 运行），返回退出码、stdout 和 stderr。 */
export async function sfly(args: string[], options: SflyOptions = {}): Promise<SflyResult> {
	const call = await cliCall(args, options);
	try {
		const { stdout, stderr } = await execFileAsync(
			"uv",
			["run", "--locked", "sfly", ...call.args],
			{
				cwd: options.cwd ?? repoRoot,
				env: call.env,
			},
		);
		return { code: 0, stdout, stderr: withoutUvNoise(stderr) };
	} catch (error) {
		const e = error as { code?: number; stdout?: string; stderr?: string };
		return { code: e.code ?? -1, stdout: e.stdout ?? "", stderr: withoutUvNoise(e.stderr ?? "") };
	}
}

/**
 * 在伪终端里运行真实的 `sfly`（它的 stdout 是终端：`isatty()` 为真）。命令行在终端上和在管道里的输出不一样
 * （终端上先过滤，#670），要看终端上的就用它。终端把换行写成 `\r\n`：按行拆时用 `/\r?\n/`。
 */
export async function sflyInTerminal(
	args: string[],
	options: SflyOptions = {},
): Promise<SflyResult> {
	const call = await cliCall(args, options);
	const runner = join(import.meta.dirname, "pty-run.py");
	try {
		const { stdout, stderr } = await execFileAsync(
			"python3",
			[runner, "uv", "run", "--locked", "sfly", ...call.args],
			{ cwd: options.cwd ?? repoRoot, env: call.env },
		);
		return { code: 0, stdout, stderr: withoutUvNoise(stderr) };
	} catch (error) {
		const e = error as { code?: number; stdout?: string; stderr?: string };
		return { code: e.code ?? -1, stdout: e.stdout ?? "", stderr: withoutUvNoise(e.stderr ?? "") };
	}
}

/** 并发跑测试时 uv 可能在 stderr 打等待锁的提示，那不是命令行的输出。 */
export function withoutUvNoise(stderr: string): string {
	return stderr
		.split("\n")
		.filter((line) => !line.startsWith("Blocking waiting for file lock"))
		.join("\n");
}
