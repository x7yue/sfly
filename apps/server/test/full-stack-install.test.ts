// 全栈：用控制面的 install.sh（跳过 systemd）把 Agent 装到临时的 SFLY_HOME，只设置 SFLY_HOME 启动它
// （其余配置都来自 install.sh 写的 agent.env）。Agent 从 GitHub Release 镜像桩安装 uv、创建共享 venv、
// 从控制面安装 SDK 运行时和节点包，跑通一条链（ADR 0011、0012）。
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { arch, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentBinary, repoRoot } from "./support/agent-binary.js";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { type ReleaseMirror, startReleaseMirror } from "./support/release-mirror.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const run = promisify(execFile);

describe("全栈：install.sh 安装的 Agent", () => {
	let cp: TestControlPlane;
	let mirror: ReleaseMirror;
	let dir: string;
	let agent: ChildProcess | undefined;
	const events: Array<Record<string, unknown>> = [];

	beforeAll(async () => {
		const bin = agentBinary();
		dir = await mkdtemp(join(tmpdir(), "sfly-full-install-"));
		const sdkDir = join(dir, "sdk");
		await run("uv", ["build", "--wheel", "--quiet", "--out-dir", sdkDir, "sdk/python"], {
			cwd: repoRoot,
		});
		mirror = await startReleaseMirror();
		cp = await startTestControlPlane({
			agentBinaries: { [arch() === "arm64" ? "aarch64" : "x86_64"]: bin },
			sdkWheelDir: sdkDir,
			githubReleaseMirror: mirror.url,
			// 桩节点包没有第三方依赖；PyPI 镜像指向一个不可用的本地端口，确保安装不访问外网。
			pypiMirror: "http://127.0.0.1:9/simple/",
		});
		const out = join(dir, "pkg");
		await run(
			"uv",
			["run", "--locked", "--quiet", "sfly", "build", "testdata/stub-package", "--out", out],
			{ cwd: repoRoot },
		);
		const res = await cp.fetch("/packages", {
			method: "POST",
			headers: { "content-type": "application/octet-stream" },
			body: await readFile(join(out, "sfly-stub-0.1.0.sflypkg")),
		});
		expect(res.status).toBe(201);
	}, 600_000);

	afterAll(async () => {
		if (agent && agent.exitCode === null) {
			const exited = new Promise((resolve) => agent?.once("exit", resolve));
			agent.kill("SIGKILL");
			await exited;
		}
		await cp?.close();
		await mirror?.close();
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("安装、启动、从镜像桩准备环境，跑通一条链", async () => {
		const home = join(dir, "home");
		const sflyHome = join(home, ".sfly");
		await run(
			"sh",
			[
				"-c",
				'curl -fsSL "$0/install.sh" | sh -s -- --name installed-agent --no-service',
				cp.httpUrl,
			],
			{ env: { PATH: process.env.PATH, HOME: home, TMPDIR: tmpdir() } },
		);

		// 共享 venv 用测试机上 uv 管理的 Python（Python 从镜像下载的路径由 agent/tests/environment.rs 覆盖）。
		const version = (await readFile(join(repoRoot, ".python-version"), "utf8")).trim();
		const python = (await run("uv", ["python", "find", "--no-project", version])).stdout.trim();
		agent = spawn(join(sflyHome, "bin", "sfly-agent"), [], {
			stdio: ["ignore", "pipe", "inherit"],
			env: {
				PATH: process.env.PATH,
				HOME: home,
				TMPDIR: tmpdir(),
				SFLY_HOME: sflyHome,
				SFLY_PYTHON: python,
			},
		});
		const lines = createInterface({ input: agent.stdout as NodeJS.ReadableStream });
		lines.on("line", (line) => events.push(JSON.parse(line) as Record<string, unknown>));
		await eventually(() => expect(events.map((e) => e.event)).toContain("welcome"), 120_000);

		expect(events.map((e) => e.event)).toEqual([
			"uv_installed",
			"venv_created",
			"sdk_installed",
			"welcome",
		]);
		expect(existsSync(join(sflyHome, "bin", "uv"))).toBe(true);
		expect(mirror.uvInstalls()).toBe(1);
		// 刚装的 uv 已是最新版：首次启动不再更新，标记已清除。
		expect(await readdir(join(sflyHome, "bin"))).not.toContain(".uv-update");

		const api = new ApiClient(cp);
		const id = await api.orchestrationWith({
			default_agent: "installed-agent",
			nodes: [
				{ id: "entry", kind: "entry" },
				{
					id: "a",
					kind: "package",
					package: "sfly-stub",
					node: "echo",
					inputs: { text: "装好了" },
				},
			],
			edges: [{ from: "entry", to: "a", kind: "chain" }],
			packages: { "sfly-stub": "0.1.0" },
		});
		const runId = await api.triggerOk(id);
		await eventually(async () => expect((await api.run(runId)).status).toBe("success"), 60_000);
		expect((await api.node(runId, "a")).outputs).toEqual({ text: "装好了" });
	}, 300_000);
});
