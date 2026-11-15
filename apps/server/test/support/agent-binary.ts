import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export const repoRoot = resolve(import.meta.dirname, "../../../..");

/**
 * 这台机器上用不了 Agent 时的原因，能用时返回 undefined。
 *
 * Agent 只能在 Linux 上编译（文件监听用 inotify），macOS 上 `cargo build -p sfly-agent` 一定失败，
 * 所以 macOS 上没有 SFLY_AGENT_BIN 就不用试。指定了 SFLY_AGENT_BIN，或者在 Linux 上，一律照常：
 * 构建失败就是测试失败。
 */
export function agentUnavailableReason(): string | undefined {
	if (process.env.SFLY_AGENT_BIN || process.platform !== "darwin") return undefined;
	return "Agent 只能在 Linux 上编译，macOS 上没有";
}

/** Agent 二进制：SFLY_AGENT_BIN 指定时直接使用，否则用 cargo 构建 debug 版本。 */
export function agentBinary(): string {
	const fromEnv = process.env.SFLY_AGENT_BIN;
	if (fromEnv) return fromEnv;
	const unavailable = agentUnavailableReason();
	if (unavailable) {
		throw new Error(
			`${unavailable}：用 pnpm linux 在 Linux 容器里运行，或用 SFLY_AGENT_BIN 指定 Agent 二进制`,
		);
	}
	execFileSync("cargo", ["build", "--quiet", "--locked", "-p", "sfly-agent"], {
		cwd: repoRoot,
		stdio: "inherit",
	});
	const targetDir = process.env.CARGO_TARGET_DIR ?? join(repoRoot, "target");
	const bin = join(
		targetDir,
		"debug",
		process.platform === "win32" ? "sfly-agent.exe" : "sfly-agent",
	);
	if (!existsSync(bin)) throw new Error(`agent binary not found at ${bin}`);
	return bin;
}
