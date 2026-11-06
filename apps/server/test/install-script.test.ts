// 切入点 A：在测试机上运行控制面生成的 install.sh（ADR 0011）。用 PATH 上的桩代替 systemctl、id、uname，
// 安装到临时的 HOME / SFLY_HOME，检查生成的文件和打印的命令。
import { execFile, spawn } from "node:child_process";
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

	it("令牌可以来自环境变量 SFLY_TOKEN（不进 shell 历史和进程列表）；--token 优先", async () => {
		let run = await install(["--name", "lab-05", "--no-service"], { SFLY_TOKEN: "from-env" });
		expect(run.code, run.stderr).toBe(0);
		const env = join(home, ".sfly", "agent.env");
		expect(await readFile(env, "utf8")).toContain("SFLY_TOKEN=from-env\n");
		run = await install(["--name", "lab-05", "--token", "from-arg", "--no-service"], {
			SFLY_TOKEN: "from-env",
		});
		expect(run.code, run.stderr).toBe(0);
		expect(await readFile(env, "utf8")).toContain("SFLY_TOKEN=from-arg\n");
	});

	it("下载被截断的脚本什么也不执行", async () => {
		const script = await (await cp.fetch("/install.sh")).text();
		const lines = script.split("\n");
		for (const fraction of [0.3, 0.5, 0.7, 0.9, 0.97]) {
			const file = join(dir, "truncated.sh");
			await writeFile(file, lines.slice(0, Math.floor(lines.length * fraction)).join("\n"));
			await promisify(execFile)("sh", [file, "--name", "lab-06", "--no-service"], {
				env: { PATH: `${stubs}:${process.env.PATH}`, HOME: home },
			}).catch(() => {});
			await expect(stat(join(home, ".sfly")), `截断在 ${fraction}`).rejects.toThrow();
		}
	});

	it("替换 Agent 二进制时与自更新拿同一把文件锁（bin/.sfly-agent.lock）", async () => {
		const bin = join(home, ".sfly", "bin");
		await mkdir(bin, { recursive: true });
		await writeFile(join(bin, "sfly-agent"), "old");
		// 另一个进程（例如正在自更新的 Agent）持有锁，直到 release 文件出现。
		const release = join(dir, "release");
		const holder = spawn(
			"flock",
			[
				join(bin, ".sfly-agent.lock"),
				"sh",
				"-c",
				`echo held; while [ ! -e '${release}' ]; do sleep 0.05; done`,
			],
			{ stdio: ["ignore", "pipe", "inherit"], detached: true },
		);
		let installer: ReturnType<typeof spawn> | undefined;
		try {
			await new Promise<void>((resolve) => holder.stdout.once("data", () => resolve()));
			installer = spawn(
				"sh",
				[
					"-c",
					'curl -fsSL "$0/install.sh" | sh -s -- "$@"',
					cp.httpUrl,
					"--name",
					"lab-07",
					"--no-service",
				],
				{
					env: { PATH: `${stubs}:${process.env.PATH}`, HOME: home },
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			const running = installer;
			let stdout = "";
			const closed = new Promise<number | null>((resolve) => running.on("close", resolve));
			await new Promise<void>((resolve, reject) => {
				running.stdout?.on("data", (chunk: Buffer) => {
					stdout += chunk.toString();
					if (stdout.includes("等待")) resolve();
				});
				closed.then(() => reject(new Error(`install.sh 没有等锁就结束了：${stdout}`)));
			});
			expect(await readFile(join(bin, "sfly-agent"), "utf8")).toBe("old");
			await writeFile(release, "");
			expect(await closed, stdout).toBe(0);
		} finally {
			// 持锁的进程组（flock 和它的子进程）、安装脚本都结束掉，失败时也不留下进程。
			try {
				if (holder.pid) process.kill(-holder.pid, "SIGKILL");
			} catch {
				// 已经结束。
			}
			installer?.kill();
		}
		expect(await readFile(join(bin, "sfly-agent"), "utf8")).toBe(fakeAgent("x86_64"));
	});

	it("重新运行时只改写安装脚本管理的键，保留其他键；没有传的令牌、槽位数、--no-auto-update 沿用原来的值", async () => {
		let run = await install([
			"--name",
			"lab-08",
			"--token",
			"s3cret",
			"--slots",
			"2",
			"--no-auto-update",
			"--no-service",
		]);
		expect(run.code, run.stderr).toBe(0);
		const env = join(home, ".sfly", "agent.env");
		await writeFile(env, `${await readFile(env, "utf8")}# 自己加的\nSFLY_TERMINATE_GRACE=30\n`);

		run = await install(["--name", "lab-09", "--no-service"]);
		expect(run.code, run.stderr).toBe(0);
		const lines = (await readFile(env, "utf8"))
			.split("\n")
			.filter((l) => l && !l.startsWith("# sfly") && !l.startsWith("# 每行"));
		expect(lines).toEqual([
			`SFLY_SERVER=${cp.grpcUrl}`,
			`SFLY_CONTROL_PLANE_URL=${cp.httpUrl}`,
			"SFLY_AGENT_NAME=lab-09",
			"SFLY_TOKEN=s3cret",
			"SFLY_SLOTS=2",
			"SFLY_NO_AUTO_UPDATE=1",
			"# 自己加的",
			"SFLY_TERMINATE_GRACE=30",
		]);
		expect((await stat(env)).mode & 0o777).toBe(0o600);
	});

	it("--dev 时 --name 可以省略，默认 dev-<用户名>-<主机名>", async () => {
		await stub("id", "case $1 in -u) echo 1000 ;; -un) echo alice ;; esac");
		await stub(
			"uname",
			"case $1 in -m) echo x86_64 ;; -n) echo lab.example.com ;; *) echo Linux ;; esac",
		);
		// 开发用的 uv：记录参数，tool dir --bin 给出 sfly 所在的目录。
		await stub(
			"uv",
			`echo "$*" >> '${join(dir, "uv.log")}'; [ "$1 $2" = 'tool dir' ] && echo '${join(home, ".local/bin")}'; exit 0`,
		);
		const run = await install(["--dev", "--no-service"]);
		expect(run.code, run.stderr).toBe(0);
		expect(await readFile(join(home, ".sfly", "agent.env"), "utf8")).toContain(
			"SFLY_AGENT_NAME=dev-alice-lab\n",
		);
		expect(await readFile(join(dir, "uv.log"), "utf8")).toContain("sfly[cli]==1.2.3");
	});

	it("缺少 --name 时报错退出", async () => {
		const run = await install(["--no-service"]);
		expect(run.code).not.toBe(0);
		expect(run.stderr).toContain("缺少 --name");
	});
});
