// 全栈（#61）：用户文档里的命令按原样能跑通。从控制面读取每一页的原文（占位符已替换成这个控制面的地址），
// 把 ```sh 代码块按页面顺序送进同一个 bash 会话，像读者在一台全新的开发机上照着做：
// install.sh --dev → sfly init → 本地调试 → sfly dev 联调 → sfly build / publish → 上传标准节点包 sfly-std。
// 读者在页面上做的事（在场景里选节点运行）由测试用 HTTP API 代做，并检查运行结果。
// 最后检查每一页的每个 sh 代码块都运行过，或者在 SKIP 里写明了原因。
//
// 环境：PATH 上只有基本命令（没有 uv、sfly、systemctl），uv 从 GitHub Release 镜像桩安装，
// PyPI 镜像桩里是测试环境里已安装的 pytest、ruff、jsonschema 和 sfly-std 的依赖重新打成的 wheel，不访问外网。
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { arch, hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { docsApi } from "@sfly/schema";
import { afterAll, beforeAll, expect, it } from "vitest";
import { DEFAULT_PROJECT } from "../src/projects/project-id.js";
import { agentBinary, repoRoot } from "./support/agent-binary.js";
import { ApiClient } from "./support/api-client.js";
import { TestAccounts } from "./support/credentials.js";
import { describeWithAgent } from "./support/describe-with-agent.js";
import { type BlockResult, DocShell, shellBlocks } from "./support/doc-commands.js";
import { eventually } from "./support/eventually.js";
import { type PypiStub, startPypiStub } from "./support/pypi-stub.js";
import { type ReleaseMirror, startReleaseMirror } from "./support/release-mirror.js";
import { buildStdPackage, type StdPackage, wheelhouse } from "./support/std-package.js";
import { startTestControlPlane } from "./support/test-control-plane.js";

const run = promisify(execFile);

/** 文档里的命令和 install.sh、uv 安装脚本桩用到的命令，链接到一个单独的 PATH 目录。 */
const TOOLS = [
	"bash",
	"sh",
	"cat",
	"chmod",
	"cp",
	"curl",
	"cut",
	"dirname",
	"echo",
	"flock",
	"git",
	"grep",
	"gzip",
	"id",
	"ls",
	"mkdir",
	"mktemp",
	"mv",
	"nohup",
	"rm",
	"sed",
	"sha256sum",
	"tar",
	"uname",
];

/**
 * 从零开始的路线：各页按目录顺序。AI 编程助手也按快速开始「自己手动开始」的步骤读这些页，没有单独的路线。
 */
const ROUTES = {
	guide: [
		"quickstart",
		"install-agent",
		"init-project",
		"sdk-reference",
		"local-debug",
		"integration",
		"platform-cli",
		"publish",
		"subflows",
		"standard-nodes",
		"cross-agent-files",
		"run-scenario",
		"feishu-notify",
		"api-client",
	],
} as const;

/** 测试环境里运行不了的代码块。 */
const SKIP: Array<{ when: (block: string) => boolean; reason: string }> = [
	{ when: (b) => /^\s*(systemctl|journalctl|loginctl)\b/m.test(b), reason: "需要 systemd" },
	{
		when: (b) => /^(npm install|pnpm add) /m.test(b),
		reason: "需要 Node.js 和包管理器：bundle-smoke.test.ts 用页面里的地址把 API 客户端装进空项目",
	},
];

/** 文档写明会失败的代码块：退出码和输出。 */
const EXPECTED_FAILURES: Array<{
	when: (page: string, block: string) => boolean;
	code: number;
	output: RegExp;
}> = [
	// 本地调试的失败路径：节点抛出异常。
	{
		when: (_, b) => b.includes('"steps": 0'),
		code: 1,
		output: /节点失败：ValueError: steps 必须大于 0/,
	},
];

/** 文档让读者按 Ctrl-C 的代码块：输出出现 `after` 后给前台进程组发 SIGINT，检查退出码和输出。 */
const INTERRUPTS: Array<{
	when: (block: string) => boolean;
	after: RegExp;
	code: number;
	output: RegExp;
}> = [
	{
		when: (b) => b.includes('"interval": 1'),
		after: /开始倒计时/,
		code: 130,
		output: /倒计时结束[\s\S]*已取消：/,
	},
];

/** 没有 systemd 时前台启动 Agent 的代码块：测试在后台运行它。 */
const isForegroundAgent = (block: string) => block.trim() === "~/.sfly/bin/sfly-agent";

const PACKAGE = "demo";
const NODE = "countdown";
/** 读者的账号：平台管理员（要签发 Agent 凭据、往公共项目发布 sfly-std），登录名同时是开发 Agent 名字里的一段。 */
const READER = "root";

describeWithAgent("全栈：开发文档里的命令", () => {
	let dir: string;
	let sdkDir: string;
	let mirror: ReleaseMirror;
	let pypi: PypiStub;
	let tools: string;
	let python: string;
	let devAgent: string;
	let std: StdPackage;
	/** 每一页的 sh 代码块（取自 docs/guide 的原文，占位符已替换）。 */
	const blocks = new Map<string, string[]>();
	const executed = new Set<string>();
	const skipped = new Set<string>();

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "sfly-full-docs-"));
		sdkDir = join(dir, "sdk");
		await run("uv", ["build", "--wheel", "--quiet", "--out-dir", sdkDir, "sdk/python"], {
			cwd: repoRoot,
		});
		// PyPI 镜像桩：把测试环境里已安装的发行版重新打成 wheel（sdk/python/tests/indexes.py）。
		pypi = await startPypiStub(
			await wheelhouse(join(dir, "wheels"), ["pytest", "ruff", "jsonschema"], {
				withStdDependencies: true,
			}),
		);
		// 「标准节点」页让读者从 Release 下载的 sfly-std：用当前源码构建（与发布流程相同的 sfly build std）。
		std = await buildStdPackage(join(dir, "std"));
		mirror = await startReleaseMirror();

		tools = join(dir, "tools");
		await mkdir(tools);
		const which = async (name: string) =>
			(await run("sh", ["-c", `command -v ${name}`])).stdout.trim();
		for (const name of TOOLS) await symlink(await which(name), join(tools, name));
		// uv 和 Agent 用测试机上 uv 管理的 Python（Python 从镜像下载的路径由 agent/tests/environment.rs 覆盖）。
		const version = (await readFile(join(repoRoot, ".python-version"), "utf8")).trim();
		python = (await run("uv", ["python", "find", "--no-project", version])).stdout.trim();
		// install.sh --dev 注册的开发 Agent：名字由控制面按登录生成 dev-<登录名>-<主机>（主机是本机的主机名，不带域名，
		// 规整成小写字母、数字、连字符；和 `sfly agent register-dev` 的默认一样）。读者是下面的管理员账号 root。
		const host = (hostname().split(".")[0] ?? "")
			.toLowerCase()
			.replace(/[^a-z0-9-]/g, "-")
			.slice(0, 32)
			.replace(/^-+|-+$/g, "");
		devAgent = `dev-${READER}-${host}`;
	}, 600_000);

	afterAll(async () => {
		await mirror?.close();
		await pypi?.close();
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	/** 一台全新的开发机：自己的控制面、HOME 和终端。 */
	async function walk(route: keyof typeof ROUTES) {
		const cp = await startTestControlPlane({
			docsDir: join(repoRoot, "docs", "guide"),
			agentBinaries: { [arch() === "arm64" ? "aarch64" : "x86_64"]: agentBinary() },
			sdkWheelDir: sdkDir,
			githubReleaseMirror: mirror.url,
			pypiMirror: pypi.indexUrl,
		});
		const api = new ApiClient(cp);
		// 读者的账号：平台管理员和他的个人令牌（控制台「令牌」页签发的那种，这里直接写库造一个）。读者在文档要求的地方
		// （注册开发 Agent 之前）把它放进环境变量 SFLY_API_TOKEN；发布 sfly-std 时也用它（文档里写作 $SFLY_ADMIN_TOKEN）。
		const accounts = new TestAccounts(cp.database.url);
		const readerId = await accounts.user(READER, { displayName: "平台管理员", admin: true });
		const readerToken = await accounts.personalToken(readerId, { name: "文档里的命令" });
		const home = join(dir, route, "home");
		const work = join(dir, route, "blocks");
		await mkdir(home, { recursive: true });
		await mkdir(work, { recursive: true });
		const env = {
			PATH: tools,
			HOME: home,
			LANG: "C.UTF-8",
			TMPDIR: process.env.TMPDIR ?? tmpdir(),
			UV_PYTHON: python,
			UV_PYTHON_DOWNLOADS: "never",
			SFLY_PYTHON: python,
			// 文档里启动的 Agent 让系统分配供其它 Agent 连接的端口：并行的测试不抢默认端口 50052。
			SFLY_LISTEN_PORT: "0",
		};
		const shell = DocShell.start({ cwd: home, env, dir: work });
		let foreground: ChildProcess | undefined;
		let foregroundLog = "";

		const agentOnline = (name: string) =>
			eventually(async () => {
				const { agents } = await api.getJson<{ agents: { name: string; status: string }[] }>(
					"/projects/default/agents",
				);
				expect(agents.find((a) => a.name === name)?.status, `${name}\n${foregroundLog}`).toBe(
					"online",
				);
			}, 180_000);

		/**
		 * 前台启动 Agent 用的环境（#492）。没有凭据的 Agent 只接受已登记过的名字：`--dev` 注册开发 Agent 之前，`agent.env`
		 * 里是安装命令给的主机名，读者按文档向平台管理员要一个 Agent 凭据，经环境变量 `SFLY_TOKEN` 交给 Agent（文档里
		 * 「用环境变量传凭据」那一段）：凭据只对签发时的名字有效，所以按 `agent.env` 里此刻的名字签发一个。`--dev` 注册之后，
		 * 名字和凭据都在 `agent.env` 里，不再从环境变量给。
		 */
		async function agentEnv(): Promise<NodeJS.ProcessEnv> {
			const text = await readFile(join(home, ".sfly", "agent.env"), "utf8");
			if (/^SFLY_TOKEN=\S/m.test(text)) return env;
			const name = /^SFLY_AGENT_NAME=(.+)$/m.exec(text)?.[1];
			if (name === undefined) throw new Error(`agent.env 里没有 SFLY_AGENT_NAME：\n${text}`);
			return {
				...env,
				SFLY_TOKEN: (await cp.current.agentCredentials.issue(DEFAULT_PROJECT, name)).token,
			};
		}

		async function startForeground(block: string) {
			foregroundLog = "";
			const child = spawn("bash", ["-c", block], {
				cwd: home,
				env: await agentEnv(),
				stdio: ["ignore", "pipe", "pipe"],
				detached: true,
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				foregroundLog += chunk.toString();
			});
			const welcome = new Promise<void>((resolve, reject) => {
				// 连不上（被控制面拒绝时 Agent 不退出、一直重试）不能永远等下去：写明 Agent 打出来的信息。
				const timer = setTimeout(
					() => reject(new Error(`Agent 5 分钟内没有连上控制面：\n${foregroundLog}`)),
					300_000,
				);
				createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
					if ((JSON.parse(line) as { event?: string }).event === "welcome") {
						clearTimeout(timer);
						resolve();
					}
				});
				child.once("exit", (code) =>
					reject(new Error(`Agent 退出（${code}）：\n${foregroundLog}`)),
				);
			});
			foreground = child;
			await welcome;
		}

		async function stopForeground() {
			const child = foreground;
			if (!child?.pid || child.exitCode !== null) return;
			const exited = new Promise((resolve) => child.once("exit", resolve));
			process.kill(-child.pid, "SIGTERM");
			await exited;
		}

		/** 读者在场景里选节点运行：本机 Agent 上的 demo 的 countdown，默认参数之外只填 name。 */
		async function runScenario(version: string) {
			const id = await api.orchestrationWith({
				default_agent: devAgent,
				nodes: [
					{ id: "entry", kind: "entry" },
					{ id: "a", kind: "package", package: PACKAGE, node: NODE, inputs: { name: "世界" } },
				],
				edges: [{ from: "entry", to: "a", kind: "chain" }],
				packages: { [PACKAGE]: version },
			});
			let runId = "";
			// sfly dev 之后 Agent 异步上报开发版本，上报之前触发预检不通过。
			await eventually(async () => {
				runId = await api.triggerOk(id);
			}, 30_000);
			await eventually(async () => expect((await api.run(runId)).status).toBe("success"), 120_000);
			expect((await api.node(runId, "a")).outputs).toEqual({ greeting: "你好，世界", ticks: 3 });
		}

		/** 像在终端里那样运行代码块（会话当前的目录和 PATH），输出出现 `after` 时按 Ctrl-C。 */
		async function interrupt(block: string, after: RegExp): Promise<BlockResult> {
			const cwd = (await shell.check("pwd")).stdout.trim();
			const path = (await shell.check('printf %s "$PATH"')).stdout;
			const child = spawn("bash", ["-c", block], {
				cwd,
				env: { ...env, PATH: path },
				stdio: ["ignore", "pipe", "pipe"],
				detached: true,
			});
			let stdout = "";
			let stderr = "";
			let sent = false;
			child.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
				if (!sent && after.test(stderr) && child.pid) {
					sent = true;
					process.kill(-child.pid, "SIGINT");
				}
			});
			const code = await new Promise<number>((resolve) =>
				child.once("exit", (c) => resolve(c ?? -1)),
			);
			return { code, stdout, stderr };
		}

		/** 读者从 GitHub Release 下载 sfly-std 的附件到 ~/Downloads（std-release.yml 发布的就是这两个文件）。 */
		async function downloadStdRelease() {
			const downloads = join(home, "Downloads");
			await mkdir(downloads, { recursive: true });
			await copyFile(std.path, join(downloads, std.file));
			const sum = (await run("sha256sum", [std.file], { cwd: downloads })).stdout;
			await writeFile(join(downloads, "SHA256SUMS"), sum);
			// 发布到公共项目要平台管理员的个人令牌（文档里写作 $SFLY_ADMIN_TOKEN）：读者在控制台账号菜单的「令牌」页
			// 签发（或 `sfly login`）；就是上面这个管理员的个人令牌，放进读者终端的环境变量。
			await shell.run(`export SFLY_ADMIN_TOKEN=${readerToken}`);
		}

		/** 读者在场景里用上传的 sfly-std 的 shell 节点（本机 Agent）。 */
		async function runStdScenario() {
			const id = await api.orchestrationWith({
				default_agent: devAgent,
				nodes: [
					{ id: "entry", kind: "entry" },
					{
						id: "sh",
						kind: "package",
						package: "sfly-std",
						node: "shell",
						inputs: { command: "echo 标准节点" },
					},
				],
				edges: [{ from: "entry", to: "sh", kind: "chain" }],
				packages: { "sfly-std": std.version },
			});
			const runId = await api.triggerOk(id);
			await eventually(async () => expect((await api.run(runId)).status).toBe("success"), 120_000);
			expect((await api.node(runId, "sh")).outputs).toEqual({
				exit_code: 0,
				stdout: "标准节点\n",
				stderr: "",
				stdout_file: null,
				stderr_file: null,
			});
		}

		/** 签发的凭据：输出里单独一行的 sfly_agt_ 开头的原值。 */
		let issued: string | undefined;

		async function after(block: string, result: BlockResult) {
			if (block.includes("sfly agent credentials issue worker-1")) {
				// 文档里的签发命令：原值单独一行，只显示这一次；控制面上 worker-1 有一个有效的凭据。
				issued = result.stdout.split("\n").find((l) => /^sfly_agt_[0-9a-f]{48}$/.test(l));
				expect(issued, result.stdout).toBeDefined();
				expect(result.stdout).toContain("read -rs SFLY_TOKEN && export SFLY_TOKEN");
				expect(result.stdout.split(issued as string).length - 1).toBe(1);
				expect(result.stderr).not.toContain(issued as string);
				const res = await cp.fetch("/projects/default/agents/worker-1/credentials", {
					headers: { authorization: `Bearer ${readerToken}` },
				});
				const listed = (await res.json()) as { credentials: unknown[] };
				expect(listed.credentials).toHaveLength(1);
			}
			if (block.includes("sfly agent credentials list worker-1")) {
				expect(issued).toBeDefined();
				expect(result.stdout).toContain(`${(issued as string).slice(0, 13)}…`);
				expect(result.stdout).toContain("有效");
				expect(result.stdout).not.toContain(issued as string);
			}
			if (block.includes("/install.sh | sh")) {
				// 有 systemd 时 install.sh 会重启服务；这里没有，读者重新运行前台启动的命令。
				if (foreground && foreground.exitCode === null) {
					await stopForeground();
					await startForeground(foreground.spawnargs.at(-1) as string);
				}
			}
			if (/\bsfly dev\b/.test(block)) {
				expect(result.stdout).toContain(`${PACKAGE}@dev`);
				await runScenario("dev");
			}
			if (/\bsfly publish\b/.test(block)) {
				const cwd = (await shell.check("pwd")).stdout.trim();
				const pyproject = await readFile(join(cwd, "pyproject.toml"), "utf8");
				const version = /^version = "([^"]+)"/m.exec(pyproject)?.[1] as string;
				expect(result.stdout).toContain(`已发布 ${PACKAGE}@${version}`);
				await runScenario(version);
			}
			if (block.includes("sfly-std-") && block.includes("/projects/default/packages")) {
				// sha256sum -c 的输出之后是 curl 打印的响应：上传的节点包版本。
				expect(result.stdout).toContain(`${std.file}: OK`);
				const published = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
				expect(published).toMatchObject({ name: "sfly-std", version: std.version });
				await runStdScenario();
			}
		}

		try {
			for (const page of ROUTES[route]) {
				const res = await cp.fetch(`/docs/${page}.md`);
				expect(res.status, page).toBe(200);
				const pageBlocks = shellBlocks(await res.text());
				blocks.set(page, pageBlocks);
				if (page === "standard-nodes") await downloadStdRelease();
				for (const block of pageBlocks) {
					const where = `${page}.md：\n${block}`;
					if (SKIP.some((s) => s.when(block))) {
						skipped.add(block);
						continue;
					}
					const failure = EXPECTED_FAILURES.find((f) => f.when(page, block));
					const ctrlC = INTERRUPTS.find((i) => i.when(block));
					if (ctrlC) {
						const result = await interrupt(block, ctrlC.after);
						expect(result.code, `${where}\n${result.stderr}`).toBe(ctrlC.code);
						expect(result.stdout + result.stderr, where).toMatch(ctrlC.output);
					} else if (failure) {
						const result = await shell.check(block);
						expect(result.code, where).toBe(failure.code);
						expect(result.stdout + result.stderr, where).toMatch(failure.output);
					} else if (isForegroundAgent(block)) {
						await startForeground(block);
					} else {
						if (block.includes("/projects/default/agents") || /\bsfly dev\b/.test(block)) {
							await agentOnline(devAgent);
						}
						// 注册开发 Agent 要读者自己的身份：文档让读者先设置个人令牌（SFLY_API_TOKEN）。
						if (block.includes("/install.sh | sh -s -- --dev")) {
							await shell.run(`export SFLY_API_TOKEN=${readerToken}`);
						}
						await after(block, await shell.run(block));
					}
					executed.add(block);
				}
			}
		} finally {
			await stopForeground();
			await shell.close();
			await accounts.close();
			await cp.close();
		}
	}

	it("从零照着各页做：安装 Agent、初始化项目、本地调试、联调、发布", async () => {
		await walk("guide");
	}, 900_000);

	it("每一页的每个 sh 代码块都运行过", async () => {
		const cp = await startTestControlPlane({ docsDir: join(repoRoot, "docs", "guide") });
		try {
			const { pages } = docsApi.list.response.parse(await (await cp.fetch("/docs")).json());
			expect(pages.map((p) => p.slug).sort()).toEqual([...ROUTES.guide].sort());
		} finally {
			await cp.close();
		}
		const missed = [...blocks.entries()].flatMap(([page, list]) =>
			list.filter((b) => !executed.has(b) && !skipped.has(b)).map((b) => `${page}.md：${b}`),
		);
		expect(missed).toEqual([]);
		expect(executed.size).toBeGreaterThan(0);
	});
});
