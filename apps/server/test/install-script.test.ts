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
		// 默认是 x86_64 Linux 上的普通用户，与跑测试的机器无关（比如在 aarch64 上或以 root 跑测试）；
		// 要别的架构或 root 的用例自己覆盖。
		await stub(
			"uname",
			"case $1 in -m) echo x86_64 ;; -n) echo lab.example.com ;; *) echo Linux ;; esac",
		);
		await stub("id", "case $1 in -u) echo 1000 ;; -un) echo alice ;; esac");
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
		// 新的会话、没有控制终端（detached）：在开发者自己的终端里跑测试时，install.sh 也看不到 /dev/tty
		// （--dev 没有登录时有终端就让人登录，没有就失败：这里要的是没有终端）。
		const child = spawn(
			"sh",
			["-c", 'curl -fsSL "$0/install.sh" | sh -s -- "$@"', cp.httpUrl, ...args],
			{
				env: { PATH: `${stubs}:${process.env.PATH}`, HOME: home, ...env },
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const code = await new Promise<number>((resolve) =>
			child.once("close", (c) => resolve(c ?? -1)),
		);
		return { code, stdout, stderr };
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
				env: { PATH: `${stubs}:${process.env.PATH}`, HOME: home },
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

	// ---- --dev：注册自己的开发 Agent（#492）。sfly CLI 用 PATH 上的桩代替：记录收到的参数（凭据不能出现在参数里），
	// 没有登录时（没有 SFLY_API_TOKEN、没有 credentials.json）`agent register-dev` 以退出码 5 结束，和真的命令行一致。
	describe("--dev 注册开发 Agent", () => {
		const TOKEN = "sfly_agt_stubstubstub0123456789abcdef";
		let sflyLog: string;
		let sflyHome: string;

		beforeEach(async () => {
			sflyHome = join(dir, "sfly");
			sflyLog = join(dir, "sfly.log");
			await stub(
				"uname",
				"case $1 in -m) echo x86_64 ;; -n) echo lab.example.com ;; *) echo Linux ;; esac",
			);
			// 开发用的 uv：记录参数；`tool dir --bin` 给出 sfly 所在的目录（下面的桩放在那里）。
			await stub(
				"uv",
				`echo "$*" >> '${join(dir, "uv.log")}'; [ "$1 $2" = 'tool dir' ] && echo '${join(home, ".local/bin")}'; exit 0`,
			);
			await mkdir(join(home, ".local/bin"), { recursive: true });
			const sfly = join(home, ".local/bin/sfly");
			await writeFile(
				sfly,
				`#!/bin/sh
echo "$*" >> '${sflyLog}'
case "$1 $2" in
"agent register-dev")
	if [ -z "\${SFLY_API_TOKEN:-}" ] && [ ! -f "$SFLY_HOME/credentials.json" ]; then
		echo "错误：没有登录凭据" >&2
		exit 5
	fi
	echo "SFLY_AGENT_NAME=dev-alice-lab"
	echo "SFLY_TOKEN=${TOKEN}"
	echo "已注册开发 Agent dev-alice-lab" >&2
	;;
"login --server")
	[ -t 0 ] && echo tty >> '${join(dir, "login-tty.log")}'
	mkdir -p "$SFLY_HOME" && echo '{}' > "$SFLY_HOME/credentials.json"
	;;
esac
`,
			);
			await chmod(sfly, 0o755);
		});

		const agentEnv = () => readFile(join(sflyHome, "agent.env"), "utf8");
		const sflyCalls = async () =>
			(await readFile(sflyLog, "utf8").catch(() => "")).split("\n").filter(Boolean);

		/** 和 `install` 一样，但在有控制终端的会话里（`support/pty-session.py`）。 */
		async function installInTerminal(
			args: string[],
			env: Record<string, string> = {},
		): Promise<Run> {
			try {
				const { stdout, stderr } = await promisify(execFile)(
					"python3",
					[
						join(import.meta.dirname, "support/pty-session.py"),
						"sh",
						"-c",
						'curl -fsSL "$0/install.sh" | sh -s -- "$@"',
						cp.httpUrl,
						...args,
					],
					{
						env: {
							PATH: `${stubs}:${process.env.PATH}`,
							HOME: home,
							// Python 在 C 语言环境里会把 LC_CTYPE 改成 C.UTF-8：macOS 的 /bin/sh（bash 3.2）在这个不存在的
							// 语言环境里把「$变量名」后面的中文当成变量名的一部分。
							PYTHONCOERCECLOCALE: "0",
							...env,
						},
					},
				);
				return { code: 0, stdout, stderr };
			} catch (error) {
				const e = error as { code: number; stdout: string; stderr: string };
				return { code: e.code, stdout: e.stdout, stderr: e.stderr };
			}
		}

		it("有 SFLY_API_TOKEN：装好 sfly CLI 之后注册，名字（控制面生成的）和凭据写进 agent.env；凭据不在任何命令行参数里，也没有打印", async () => {
			const run = await install(["--dev", "--no-service"], {
				SFLY_HOME: sflyHome,
				SFLY_API_TOKEN: "sfly_pat_personal",
			});
			expect(run.code, run.stderr).toBe(0);
			expect(await readFile(join(dir, "uv.log"), "utf8")).toContain("sfly[cli]==1.2.3");
			const env = await agentEnv();
			expect(env).toContain("SFLY_AGENT_NAME=dev-alice-lab\n");
			expect(env).toContain(`SFLY_TOKEN=${TOKEN}\n`);
			// 注册用 --env（两行 KEY=值 写到标准输出，只放在 shell 变量里），控制面地址显式给出。
			expect(await sflyCalls()).toEqual([`agent register-dev --server ${cp.httpUrl} --env`]);
			expect(run.stdout + run.stderr).not.toContain(TOKEN);
			expect(run.stdout).toContain("已注册开发 Agent dev-alice-lab");
			expect((await stat(join(sflyHome, "agent.env"))).mode & 0o777).toBe(0o600);
		});

		it("没有登录也没有终端：直接失败并写明怎么办，不登录、不等输入；Agent 二进制和 sfly CLI 已经装好，没有写 agent.env", async () => {
			const run = await install(["--dev", "--no-service"], { SFLY_HOME: sflyHome });
			expect(run.code).toBe(1);
			expect(run.stderr).toContain("SFLY_API_TOKEN");
			expect(run.stderr).toContain(`sfly login --server ${cp.httpUrl}`);
			expect(run.stderr).toContain("重新运行同一条命令");
			expect(await sflyCalls()).toEqual([`agent register-dev --server ${cp.httpUrl} --env`]);
			expect((await stat(join(sflyHome, "bin", "sfly-agent"))).isFile()).toBe(true);
			expect(await readFile(join(dir, "uv.log"), "utf8")).toContain("sfly[cli]==1.2.3");
			expect(await agentEnv().catch(() => "没有这个文件")).toBe("没有这个文件");
		});

		it("没有登录、有终端：运行 sfly login（stdin 是终端），再注册一次", async () => {
			const run = await installInTerminal(["--dev", "--no-service"], { SFLY_HOME: sflyHome });
			expect(run.code, run.stdout).toBe(0);
			expect(await sflyCalls()).toEqual([
				`agent register-dev --server ${cp.httpUrl} --env`,
				`login --server ${cp.httpUrl}`,
				`agent register-dev --server ${cp.httpUrl} --env`,
			]);
			expect(await readFile(join(dir, "login-tty.log"), "utf8")).toBe("tty\n");
			expect(run.stdout).toContain(`先登录 ${cp.httpUrl}`);
			expect(await agentEnv()).toContain("SFLY_AGENT_NAME=dev-alice-lab\n");
			expect(run.stdout).not.toContain(TOKEN);
		});

		it("登录了但还是被拒绝（不是没有登录凭据）：失败，不再让人登录", async () => {
			await stub("uname", "case $1 in -m) echo x86_64 ;; -n) echo lab ;; *) echo Linux ;; esac");
			const sfly = join(home, ".local/bin/sfly");
			await writeFile(
				sfly,
				`#!/bin/sh\necho "$*" >> '${sflyLog}'\n[ "$1 $2" = 'agent register-dev' ] && { echo '错误：已经有一台叫 dev-alice-lab 的 Agent' >&2; exit 2; }\n`,
			);
			const run = await installInTerminal(["--dev", "--no-service"], { SFLY_HOME: sflyHome });
			expect(run.code).toBe(1);
			expect(run.stdout).toContain("已经有一台叫 dev-alice-lab");
			expect(run.stdout).toContain("注册开发 Agent 失败");
			expect(await sflyCalls()).toEqual([`agent register-dev --server ${cp.httpUrl} --env`]);
		});

		it("重新运行（升级）：agent.env 里已有开发 Agent 的名字和凭据就沿用，不再注册", async () => {
			let run = await install(["--dev", "--no-service"], {
				SFLY_HOME: sflyHome,
				SFLY_API_TOKEN: "sfly_pat_personal",
			});
			expect(run.code, run.stderr).toBe(0);
			await rm(sflyLog);
			// 第二次没有登录也没有终端：照样成功（沿用）。
			run = await install(["--dev", "--no-service"], { SFLY_HOME: sflyHome });
			expect(run.code, run.stderr).toBe(0);
			expect(run.stdout).toContain("沿用");
			expect(await sflyCalls()).toEqual([]);
			const env = await agentEnv();
			expect(env).toContain("SFLY_AGENT_NAME=dev-alice-lab\n");
			expect(env).toContain(`SFLY_TOKEN=${TOKEN}\n`);
			// 删掉那两行：重新注册。
			await writeFile(
				join(sflyHome, "agent.env"),
				env
					.split("\n")
					.filter((l) => !l.startsWith("SFLY_AGENT_NAME=") && !l.startsWith("SFLY_TOKEN="))
					.join("\n"),
			);
			run = await install(["--dev", "--no-service"], {
				SFLY_HOME: sflyHome,
				SFLY_API_TOKEN: "sfly_pat_personal",
			});
			expect(run.code, run.stderr).toBe(0);
			expect(await sflyCalls()).toEqual([`agent register-dev --server ${cp.httpUrl} --env`]);
		});

		it("agent.env 里的名字是 dev- 开头但没有凭据（旧版本装的）：重新注册，换成控制面生成的名字", async () => {
			await mkdir(sflyHome, { recursive: true });
			await writeFile(join(sflyHome, "agent.env"), "SFLY_AGENT_NAME=dev-bob-oldhost\n");
			const run = await install(["--dev", "--no-service"], {
				SFLY_HOME: sflyHome,
				SFLY_API_TOKEN: "sfly_pat_personal",
			});
			expect(run.code, run.stderr).toBe(0);
			expect(await agentEnv()).toContain("SFLY_AGENT_NAME=dev-alice-lab\n");
			expect(await agentEnv()).not.toContain("dev-bob-oldhost");
		});

		it("--dev 不给 --name 时不能给 --token（名字和凭据都由控制面生成）；SFLY_TOKEN 环境变量也一样", async () => {
			for (const run of [
				await install(["--dev", "--token", "x", "--no-service"], { SFLY_HOME: sflyHome }),
				await install(["--dev", "--no-service"], { SFLY_HOME: sflyHome, SFLY_TOKEN: "x" }),
			]) {
				expect(run.code).toBe(1);
				expect(run.stderr).toContain("同时给 --name 和 --token");
			}
			expect(await sflyCalls()).toEqual([]);
		});

		it("--dev 同时给 --name 和 --token（管理员签发的 Agent 凭据）：不注册，名字和凭据照写，sfly CLI 照装", async () => {
			const run = await install(
				["--dev", "--name", "bench-1", "--token", "sfly_agt_issued", "--no-service"],
				{ SFLY_HOME: sflyHome },
			);
			expect(run.code, run.stderr).toBe(0);
			expect(await sflyCalls()).toEqual([]);
			const env = await agentEnv();
			expect(env).toContain("SFLY_AGENT_NAME=bench-1\n");
			expect(env).toContain("SFLY_TOKEN=sfly_agt_issued\n");
			expect(await readFile(join(dir, "uv.log"), "utf8")).toContain("sfly[cli]==1.2.3");
		});

		it("不加 --dev 时不装 sfly CLI、不注册；缺 --name 照旧报错", async () => {
			const run = await install(["--no-service"], { SFLY_HOME: sflyHome });
			expect(run.code).toBe(1);
			expect(run.stderr).toContain("缺少 --name");
			expect(await sflyCalls()).toEqual([]);
		});
	});

	it("下载时 curl 带 sfly 的 User-Agent；SFLY_USER_AGENT 覆盖它并写进 agent.env，不合法时报错", async () => {
		const curl = (await promisify(execFile)("sh", ["-c", "command -v curl"])).stdout.trim();
		const log = join(dir, "curl.log");
		await stub("curl", `echo "$*" >> '${log}'\nexec '${curl}' "$@"`);
		const binary = `${cp.httpUrl}/agent/binaries/1.2.3/x86_64`;
		const downloads = async () =>
			(await readFile(log, "utf8")).split("\n").filter((l) => l.endsWith(binary));

		let run = await install(["--name", "lab-ua", "--no-service"]);
		expect(run.code, run.stderr).toBe(0);
		expect(await downloads()).toEqual([expect.stringContaining("-A sfly-agent/1.2.3 ")]);

		await rm(log);
		run = await install(["--name", "lab-ua", "--no-service"], {
			SFLY_USER_AGENT: "acme-lab-sfly/1.0",
		});
		expect(run.code, run.stderr).toBe(0);
		expect(await downloads()).toEqual([expect.stringContaining("-A acme-lab-sfly/1.0 ")]);
		const env = join(home, ".sfly", "agent.env");
		expect(await readFile(env, "utf8")).toContain("SFLY_USER_AGENT=acme-lab-sfly/1.0\n");

		// 重新运行时沿用 agent.env 里的值。
		await rm(log);
		run = await install(["--name", "lab-ua", "--no-service"]);
		expect(run.code, run.stderr).toBe(0);
		expect(await downloads()).toEqual([expect.stringContaining("-A acme-lab-sfly/1.0 ")]);

		run = await install(["--name", "lab-ua", "--no-service"], { SFLY_USER_AGENT: 'bad"ua' });
		expect(run.code).not.toBe(0);
		expect(run.stderr).toContain("SFLY_USER_AGENT 只能包含可打印 ASCII 字符");
	});

	it("--listen-port、--public-address 写进 agent.env；重新运行没有传时沿用原来的值", async () => {
		let run = await install([
			"--name",
			"lab-10",
			"--listen-port",
			"6000",
			"--public-address",
			"10.0.0.5",
			"--no-service",
		]);
		expect(run.code, run.stderr).toBe(0);
		const env = join(home, ".sfly", "agent.env");
		const managed = async () =>
			(await readFile(env, "utf8"))
				.split("\n")
				.filter((l) => /^SFLY_(LISTEN_PORT|PUBLIC_ADDRESS)=/.test(l));
		expect(await managed()).toEqual(["SFLY_LISTEN_PORT=6000", "SFLY_PUBLIC_ADDRESS=10.0.0.5"]);

		run = await install(["--name", "lab-10", "--no-service"]);
		expect(run.code, run.stderr).toBe(0);
		expect(await managed()).toEqual(["SFLY_LISTEN_PORT=6000", "SFLY_PUBLIC_ADDRESS=10.0.0.5"]);

		run = await install(["--name", "lab-10", "--listen-port=6001", "--no-service"]);
		expect(run.code, run.stderr).toBe(0);
		expect(await managed()).toEqual(["SFLY_LISTEN_PORT=6001", "SFLY_PUBLIC_ADDRESS=10.0.0.5"]);
	});

	it("--listen-port 不是 1–65535 的整数、--public-address 带协议或端口时报错退出", async () => {
		for (const port of ["0", "65536", "abc", "080"]) {
			const run = await install(["--name", "lab-11", "--listen-port", port, "--no-service"]);
			expect(run.code, port).not.toBe(0);
			expect(run.stderr).toContain(`--listen-port 必须是 1–65535 的整数：${port}`);
		}
		for (const address of ["http://10.0.0.5", "10.0.0.5:6000", "two words"]) {
			const run = await install(["--name", "lab-11", "--public-address", address, "--no-service"]);
			expect(run.code, address).not.toBe(0);
			expect(run.stderr).toContain(
				`--public-address 只能是 IP 地址或主机名（不带协议和端口）：${address}`,
			);
		}
	});

	it("缺少 --name 时报错退出", async () => {
		const run = await install(["--no-service"]);
		expect(run.code).not.toBe(0);
		expect(run.stderr).toContain("缺少 --name");
	});
});
