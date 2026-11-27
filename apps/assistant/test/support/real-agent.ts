// 真的 Agent（Rust，agent/）当工作台：只用它的能力端口（ADR 0019，gRPC，没有认证），不连控制面。
// Agent 在连控制面之前就开了能力端口、连不上时一直重试，所以 `--server` 指向一个没人听的地址就够了。
// Agent 只能在 Linux 上编译（文件监听用 inotify）：macOS 上没有 SFLY_AGENT_BIN 就跳过，用 `pnpm linux` 在 Linux 容器里跑。
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eventually } from "./eventually.js";

const repoRoot = resolve(import.meta.dirname, "../../../..");

/** 这台机器上用不了 Agent 时的原因，能用时返回 undefined（和 apps/server/test/support/agent-binary.ts 同一个规矩）。 */
export function agentUnavailableReason(): string | undefined {
	if (process.env.SFLY_AGENT_BIN || process.platform !== "darwin") return undefined;
	return "Agent 只能在 Linux 上编译，macOS 上没有";
}

/** Agent 二进制：SFLY_AGENT_BIN 指定时直接用，否则 cargo 构建 debug 版本。 */
export function agentBinary(): string {
	const fromEnv = process.env.SFLY_AGENT_BIN;
	if (fromEnv) return fromEnv;
	execFileSync("cargo", ["build", "--quiet", "--locked", "-p", "sfly-agent"], {
		cwd: repoRoot,
		stdio: "inherit",
	});
	const bin = join(process.env.CARGO_TARGET_DIR ?? join(repoRoot, "target"), "debug", "sfly-agent");
	if (!existsSync(bin)) throw new Error(`找不到 Agent 二进制 ${bin}`);
	return bin;
}

export interface WorkbenchAgent {
	/** 能力端口的地址（`主机:端口`）。 */
	address: string;
	close(): Promise<void>;
}

/** 启动一台真的 Agent，等到它的能力端口能连上。 */
export async function startWorkbenchAgent(bin: string): Promise<WorkbenchAgent> {
	const home = mkdtempSync(join(tmpdir(), "sfly-wb-agent-"));
	const port = await freePort();
	const child: ChildProcess = spawn(
		bin,
		[
			"--server",
			"http://127.0.0.1:9",
			"--name",
			"commit-test-agent",
			"--venv",
			join(home, "venv"),
			"--work-dir",
			join(home, "tasks"),
			// 用测试机 PATH 上的 uv：不让 Agent 去装自己管理的 uv（要访问外网）；连不上控制面，用不到它。
			"--uv",
			"uv",
		],
		{
			stdio: ["ignore", "ignore", "pipe"],
			env: {
				...process.env,
				SFLY_HOME: join(home, "sfly-home"),
				SFLY_LISTEN_PORT: String(port),
				SFLY_PUBLIC_ADDRESS: "127.0.0.1",
			},
		},
	);
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const exited = new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
	try {
		await eventually(async () => {
			if (child.exitCode !== null) throw new Error(`Agent 退出了（${child.exitCode}）：${stderr}`);
			await new Promise<void>((done, fail) => {
				const socket = connect(port, "127.0.0.1", () => {
					socket.destroy();
					done();
				});
				socket.on("error", fail);
			});
		}, 30_000);
	} catch (error) {
		child.kill("SIGKILL");
		await exited;
		rmSync(home, { recursive: true, force: true });
		throw new Error(`${(error as Error).message}\n${stderr}`);
	}
	return {
		address: `127.0.0.1:${port}`,
		close: async () => {
			if (child.exitCode === null) {
				child.kill("SIGKILL");
				await exited;
			}
			rmSync(home, { recursive: true, force: true });
		},
	};
}

/** 系统分配一个空闲端口（用完就放掉）。 */
async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const { port } = server.address() as { port: number };
	await new Promise<void>((done) => server.close(() => done()));
	return port;
}
