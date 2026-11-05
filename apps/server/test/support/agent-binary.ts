import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export const repoRoot = resolve(import.meta.dirname, "../../../..");

/** Agent 二进制：SFLY_AGENT_BIN 指定时直接使用，否则用 cargo 构建 debug 版本。 */
export function agentBinary(): string {
	const fromEnv = process.env.SFLY_AGENT_BIN;
	if (fromEnv) return fromEnv;
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
