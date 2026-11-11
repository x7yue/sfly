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
import { arch, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { docsApi } from "@sfly/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentBinary, repoRoot } from "./support/agent-binary.js";
import { ApiClient } from "./support/api-client.js";
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
		"publish",
		"subflows",
		"standard-nodes",
	],
} as const;

/** 测试环境里运行不了的代码块。 */
const SKIP: Array<{ when: (block: string) => boolean; reason: string }> = [
	{ when: (b) => /^\s*(systemctl|journalctl|loginctl)\b/m.test(b), reason: "需要 systemd" },
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

describe("全栈：开发文档里的命令", () => {
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
		// install.sh --dev 的默认名称：dev-<用户名>-<主机名>（不带域名）。
		devAgent = (await run("sh", ["-c", 'printf %s "dev-$(id -un)-$(uname -n | cut -d. -f1)"']))
			.stdout;
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
					"/agents",
				);
				expect(agents.find((a) => a.name === name)?.status, `${name}\n${foregroundLog}`).toBe(
					"online",
				);
			}, 180_000);

		async function startForeground(block: string) {
			foregroundLog = "";
			const child = spawn("bash", ["-c", block], {
				cwd: home,
				env,
				stdio: ["ignore", "pipe", "pipe"],
				detached: true,
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				foregroundLog += chunk.toString();
			});
			const welcome = new Promise<void>((resolve, reject) => {
				createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
					if ((JSON.parse(line) as { event?: string }).event === "welcome") resolve();
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

		async function after(block: string, result: BlockResult) {
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
			if (block.includes("sfly-std-") && block.includes("/packages")) {
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
						if (block.includes("/agents") || /\bsfly dev\b/.test(block)) {
							await agentOnline(devAgent);
						}
						await after(block, await shell.run(block));
					}
					executed.add(block);
				}
			}
		} finally {
			await stopForeground();
			await shell.close();
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
