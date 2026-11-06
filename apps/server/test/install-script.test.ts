// 切入点 A：在测试机上运行控制面生成的 install.sh（ADR 0011）。用 PATH 上的桩代替 systemctl、id、uname，
// 安装到临时的 HOME / SFLY_HOME，检查生成的文件和打印的命令。
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

/** 冒充 Agent 二进制的脚本：只回答 --version。 */
const fakeAgent = (arch: string) => `#!/bin/sh\necho "sfly-agent 1.2.3 ${arch}"\n`;

interface Run {
	code: number;
	stdout: string;
	stderr: string;
}

describe("install.sh", () => {
	let cp: TestControlPlane;
	let binDir: string;
	let dir: string;
	let home: string;
	let stubs: string;

	beforeAll(async () => {
		binDir = await mkdtemp(join(tmpdir(), "sfly-install-bin-"));
		await writeFile(join(binDir, "x86"), fakeAgent("x86_64"));
		await writeFile(join(binDir, "arm"), fakeAgent("aarch64"));
		cp = await startTestControlPlane({
			version: "1.2.3",
			agentBinaries: { x86_64: join(binDir, "x86"), aarch64: join(binDir, "arm") },
		});
	});
	afterAll(async () => {
		await cp?.close();
		await rm(binDir, { recursive: true, force: true });
	});

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "sfly-install-"));
		home = join(dir, "home");
		stubs = join(dir, "stubs");
		await mkdir(home, { recursive: true });
		await mkdir(stubs);
		// systemctl 的桩：记录参数。
		await stub("systemctl", `echo "$*" >> '${join(dir, "systemctl.log")}'`);
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	async function stub(name: string, body: string) {
		const file = join(stubs, name);
		await writeFile(file, `#!/bin/sh\n${body}\n`);
		await chmod(file, 0o755);
	}

	/** `curl -fsSL <控制面>/install.sh | sh -s -- <参数>`。 */
	async function install(args: string[], env: Record<string, string> = {}): Promise<Run> {
		try {
			const { stdout, stderr } = await promisify(execFile)(
				"sh",
				["-c", 'curl -fsSL "$0/install.sh" | sh -s -- "$@"', cp.httpUrl, ...args],
				{ env: { PATH: `${stubs}:${process.env.PATH}`, HOME: home, ...env } },
			);
			return { code: 0, stdout, stderr };
		} catch (error) {
			const e = error as { code: number; stdout: string; stderr: string };
			return { code: e.code, stdout: e.stdout, stderr: e.stderr };
		}
	}

	const systemctlCalls = async () =>
		(await readFile(join(dir, "systemctl.log"), "utf8").catch(() => "")).trim().split("\n");

	it("跳过 systemd：下载本机架构的 Agent 到 SFLY_HOME/bin，写入 agent.env，打印前台启动命令", async () => {
		const sflyHome = join(dir, "sfly");
		const run = await install(
			["--name", "lab-01", "--token", "s3cret", "--slots", "3", "--no-service"],
			{ SFLY_HOME: sflyHome },
		);
		expect(run.code, run.stderr).toBe(0);

		const agent = join(sflyHome, "bin", "sfly-agent");
		expect(await readFile(agent, "utf8")).toBe(fakeAgent("x86_64"));
		expect((await stat(agent)).mode & 0o777).toBe(0o755);
		const env = join(sflyHome, "agent.env");
		expect((await stat(env)).mode & 0o777).toBe(0o600);
		const lines = (await readFile(env, "utf8")).split("\n").filter((l) => l && !l.startsWith("#"));
		expect(lines).toEqual([
			`SFLY_SERVER=${cp.grpcUrl}`,
			`SFLY_CONTROL_PLANE_URL=${cp.httpUrl}`,
			"SFLY_AGENT_NAME=lab-01",
			"SFLY_TOKEN=s3cret",
			"SFLY_SLOTS=3",
		]);
		// 安装后首次启动时更新 uv 的标记（Agent 读取后删除）。
		expect((await stat(join(sflyHome, "bin", ".uv-update"))).isFile()).toBe(true);
		expect(run.stdout).toContain(`前台启动：SFLY_HOME='${sflyHome}' '${agent}'`);
		expect(await systemctlCalls()).toEqual([""]);
	});

	it("默认装到 ~/.sfly；aarch64 机器下载 aarch64 的 Agent", async () => {
		await stub("uname", "case $1 in -m) echo aarch64 ;; *) echo Linux ;; esac");
		const run = await install(["--name", "arm-01", "--no-service"]);
		expect(run.code, run.stderr).toBe(0);
		expect(await readFile(join(home, ".sfly", "bin", "sfly-agent"), "utf8")).toBe(
			fakeAgent("aarch64"),
		);
	});

	it("普通用户：注册用户级 systemd 服务并启动，打印前台启动命令", async () => {
		const run = await install(["--name", "lab-02"]);
		expect(run.code, run.stderr).toBe(0);
		const sflyHome = join(home, ".sfly");
		const unit = await readFile(join(home, ".config/systemd/user/sfly-agent.service"), "utf8");
		expect(unit).toContain(`Environment="SFLY_HOME=${sflyHome}"`);
		expect(unit).toContain(`ExecStart="${sflyHome}/bin/sfly-agent"`);
		expect(unit).toContain("Restart=on-failure\n");
		expect(unit).toContain("RestartPreventExitStatus=78\n");
		expect(unit).toContain("WantedBy=default.target\n");
		expect(await systemctlCalls()).toEqual([
			"--user daemon-reload",
			"--user enable sfly-agent.service",
			"--user restart sfly-agent.service",
		]);
		expect(run.stdout).toContain(`前台启动：SFLY_HOME='${sflyHome}' '${sflyHome}/bin/sfly-agent'`);
	});

	it("root：注册系统级 systemd 服务，单元里显式写 SFLY_HOME", async () => {
		await stub("id", "case $1 in -u) echo 0 ;; *) echo root ;; esac");
		const units = join(dir, "system-units");
		const run = await install(["--name", "lab-03"], { SFLY_SYSTEMD_DIR: units });
		expect(run.code, run.stderr).toBe(0);
		const sflyHome = join(home, ".sfly");
		const unit = await readFile(join(units, "sfly-agent.service"), "utf8");
		expect(unit).toContain(`Environment="SFLY_HOME=${sflyHome}"`);
		expect(unit).toContain(`ExecStart="${sflyHome}/bin/sfly-agent"`);
		expect(unit).toContain("Restart=on-failure\n");
		expect(unit).toContain("RestartPreventExitStatus=78\n");
		expect(unit).toContain("After=network-online.target\n");
		expect(unit).toContain("WantedBy=multi-user.target\n");
		expect(await systemctlCalls()).toEqual([
			"daemon-reload",
			"enable sfly-agent.service",
			"restart sfly-agent.service",
		]);
	});

	it("下载的文件与 sha256 不符时不安装", async () => {
		// 先取得脚本（其中的 sha256 是当前文件的），再换掉控制面上的文件。
		const script = await (await cp.fetch("/install.sh")).text();
		await writeFile(join(binDir, "x86"), fakeAgent("tampered"));
		try {
			const file = join(dir, "install.sh");
			await writeFile(file, script);
			const run = await promisify(execFile)("sh", [file, "--name", "lab-04", "--no-service"], {
				env: { PATH: process.env.PATH, HOME: home },
			}).then(
				() => ({ code: 0, stderr: "" }),
				(e: { code: number; stderr: string }) => e,
			);
			expect(run.code).not.toBe(0);
			expect(run.stderr).toContain("sha256 校验失败");
			await expect(stat(join(home, ".sfly", "bin", "sfly-agent"))).rejects.toThrow();
		} finally {
			await writeFile(join(binDir, "x86"), fakeAgent("x86_64"));
		}
	});

	it("缺少 --name 时报错退出", async () => {
		const run = await install(["--no-service"]);
		expect(run.code).not.toBe(0);
		expect(run.stderr).toContain("缺少 --name");
	});
});
