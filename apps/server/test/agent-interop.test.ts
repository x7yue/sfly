// 互通测试：真实的 Rust Agent（tonic 客户端）用标准 gRPC 连上控制面网关。
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const repoRoot = resolve(import.meta.dirname, "../../..");

/** Agent 二进制：SFLY_AGENT_BIN 指定时直接使用，否则用 cargo 构建 debug 版本。 */
function agentBinary(): string {
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

describe("Rust Agent 与控制面互通", () => {
	let cp: TestControlPlane;
	let bin: string;
	let child: ChildProcess | undefined;

	beforeAll(async () => {
		bin = agentBinary();
		cp = await startTestControlPlane();
	}, 600_000);

	afterAll(async () => {
		child?.kill("SIGKILL");
		await cp?.close();
	});

	it("Agent 完成 Hello/Welcome 握手", async () => {
		child = spawn(bin, ["--server", cp.grpcUrl, "--name", "interop-agent"], {
			stdio: ["ignore", "pipe", "inherit"],
		});
		const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream });
		const event = await new Promise<Record<string, unknown>>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("agent did not report welcome")), 15_000);
			lines.on("line", (line) => {
				const parsed = JSON.parse(line) as Record<string, unknown>;
				if (parsed.event === "welcome") {
					clearTimeout(timer);
					resolve(parsed);
				}
			});
			child?.on("exit", (code) => reject(new Error(`agent exited early with ${code}`)));
		});
		expect(event).toEqual({ event: "welcome", name: "interop-agent" });
	}, 30_000);
});
