// 打包后的控制面冒烟（ADR 0010、0011）：用 node 运行 out/server/main.mjs，不设置目录类环境变量（验证单文件包
// 自带的 web/、sdk/、client/、drizzle/、docs/、agent/ 布局）；用控制面的 install.sh 安装它带的 Agent，
// 这个 Agent 从全新的 venv 开始，从控制面下载 SDK 运行时和节点包，跑通一条链。
// 覆盖打包最容易出问题的地方：迁移、HTTP API 与页面、用户文档、Agent 下载与 install.sh、节点包上传解压、
// gRPC（HTTP/2）、SDK 与节点包下载、API 客户端安装包。
// 只在设置 SFLY_BUNDLE_DIR 时运行：根目录 `pnpm bundle:server && pnpm test:bundle`。
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { arch, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { repoRoot } from "./support/agent-binary.js";
import { ApiClient } from "./support/api-client.js";
import { type BundledServer, startBundledServer } from "./support/bundled-server.js";
import { shellBlocks } from "./support/doc-commands.js";
import { typecheckExamples } from "./support/doc-examples.js";
import { eventually } from "./support/eventually.js";
import { type RealAgent, startRealAgent } from "./support/real-agent.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

const bundleDir = process.env.SFLY_BUNDLE_DIR;
const { version } = packageJson;

describe.skipIf(!bundleDir)("打包后的控制面", () => {
	let database: TestDatabase;
	let dataDir: string;
	let server: BundledServer;
	let agent: RealAgent;
	let sflyHome: string;
	const fetchPath = (path: string, init?: RequestInit) => fetch(`${server.httpUrl}${path}`, init);
	const api = new ApiClient({ fetch: fetchPath });

	beforeAll(async () => {
		[database, dataDir, sflyHome] = await Promise.all([
			createTestDatabase(),
			mkdtemp(join(tmpdir(), "sfly-bundle-data-")),
			mkdtemp(join(tmpdir(), "sfly-bundle-home-")),
		]);
		server = await startBundledServer({
			dir: bundleDir as string,
			databaseUrl: database.url,
			dataDir,
		});
	}, 60_000);

	afterAll(async () => {
		await agent?.close();
		await server?.stop();
		await database?.drop();
		if (dataDir) await rm(dataDir, { recursive: true, force: true });
		if (sflyHome) await rm(sflyHome, { recursive: true, force: true });
	});

	it("健康检查、页面和同版本的 SDK wheel 都可用", async () => {
		const health = await fetchPath("/api/health");
		expect(health.status).toBe(200);
		expect(await health.json()).toMatchObject({ status: "ok", database: "ok" });

		const page = await fetchPath("/", { headers: { accept: "text/html" } });
		expect(page.status).toBe(200);
		expect(await page.text()).toMatch(/<!doctype html>/i);

		const { wheels } = await api.getJson<{ wheels: Array<{ version: string }> }>("/sdk/python");
		expect(wheels.map((w) => w.version)).toEqual([version]);
	});

	it.each([
		["npm", ["install", "--no-audit", "--no-fund"]],
		["pnpm", ["add"]],
	])(
		"提供同版本的 API 客户端安装包，%s 按用户文档里的地址装进空项目后导入并调通健康检查，文档的示例代码对着装好的包通过类型检查",
		async (manager, install) => {
			const { tarballs } = await api.getJson<{ tarballs: Array<{ version: string; url: string }> }>(
				"/client",
			);
			expect(tarballs.map((t) => t.version)).toEqual([version]);
			const doc = await (await fetchPath("/docs/api-client.md")).text();
			const command = shellBlocks(doc)
				.flatMap((block) => block.split("\n"))
				.find((line) => line.startsWith(`${manager} `));
			const url = command?.split(" ").at(-1) ?? "";
			expect(url).toBe(tarballs[0]?.url);

			const project = await mkdtemp(join(tmpdir(), "sfly-client-project-"));
			const run = (command: string, args: string[]) =>
				promisify(execFile)(command, args, {
					cwd: project,
					env: { PATH: process.env.PATH, HOME: process.env.HOME },
				});
			try {
				await writeFile(
					join(project, "package.json"),
					JSON.stringify({ name: "dashboard", private: true, type: "module" }),
				);
				await run(manager, [...install, url]);
				await writeFile(
					join(project, "check.mjs"),
					`import { createClient } from "@sfly/client";
const client = createClient({ baseUrl: ${JSON.stringify(server.httpUrl)} });
console.log(JSON.stringify(await client.system.health()));
`,
				);
				const { stdout } = await run("node", ["check.mjs"]);
				expect(JSON.parse(stdout)).toMatchObject({ status: "ok", database: "ok" });
				expect(typecheckExamples(doc, "api-client.md", project)).toEqual([]);
			} finally {
				await rm(project, { recursive: true, force: true });
			}
		},
		120_000,
	);

	it("自带的用户文档：原文替换了控制面地址和版本，llms.txt 列出全部页面", async () => {
		const page = await fetchPath("/docs/quickstart.md");
		expect(page.status).toBe(200);
		const text = await page.text();
		expect(text).toContain(`curl -s ${server.httpUrl}/llms.txt`);
		expect(text).toContain(version);

		const index = await (await fetchPath("/llms.txt")).text();
		const { pages } = await api.getJson<{ pages: Array<{ slug: string }> }>("/docs");
		expect(pages.length).toBeGreaterThan(0);
		for (const { slug } of pages) expect(index).toContain(`(${server.httpUrl}/docs/${slug}.md)`);
		// 两份 skill（节点开发、操作平台）随文档一起打包。
		for (const skill of ["sfly-node-dev", "sfly-platform"]) {
			for (const file of ["SKILL.md", "reference.md"]) {
				expect((await fetchPath(`/docs/skills/${skill}/${file}`)).status, `${skill}/${file}`).toBe(
					200,
				);
				expect(index).toContain(`(${server.httpUrl}/docs/skills/${skill}/${file})`);
			}
		}
	});

	it("提供两个架构的同版本 Agent；install.sh 安装本机架构的 Agent", async () => {
		const list = await api.getJson<{ binaries: Array<{ arch: string; version: string }> }>(
			"/agent/binaries",
		);
		expect(list.binaries.map((b) => [b.arch, b.version])).toEqual([
			["x86_64", version],
			["aarch64", version],
		]);

		const { stdout } = await promisify(execFile)(
			"sh",
			[
				"-c",
				'curl -fsSL "$0/install.sh" | sh -s -- --name bundle-agent --no-service',
				server.httpUrl,
			],
			{ env: { PATH: process.env.PATH, HOME: sflyHome, SFLY_HOME: sflyHome } },
		);
		expect(stdout).toContain("前台启动");
		const hostArch = arch() === "arm64" ? "aarch64" : "x86_64";
		const installed = await readFile(join(sflyHome, "bin", "sfly-agent"));
		const bundled = await readFile(join(bundleDir as string, "agent", hostArch, "sfly-agent"));
		expect(installed.equals(bundled)).toBe(true);
		const env = await readFile(join(sflyHome, "agent.env"), "utf8");
		expect(env).toContain(`SFLY_SERVER=${server.grpcUrl}\n`);
		expect(env).toContain(`SFLY_CONTROL_PLANE_URL=${server.httpUrl}\n`);
	});

	it("install.sh 装好的 Agent 从全新 venv 开始安装 SDK 和节点包，跑通一条链", async () => {
		// 发布桩节点包（经 HTTP 上传，控制面解压校验）。
		const out = await mkdtemp(join(tmpdir(), "sfly-bundle-pkg-"));
		try {
			await promisify(execFile)(
				"uv",
				["run", "--locked", "--quiet", "sfly", "build", "testdata/stub-package", "--out", out],
				{ cwd: repoRoot },
			);
			const res = await fetchPath("/packages", {
				method: "POST",
				headers: { "content-type": "application/octet-stream" },
				body: await readFile(join(out, "sfly-stub-0.1.0.sflypkg")),
			});
			expect(res.status).toBe(201);
		} finally {
			await rm(out, { recursive: true, force: true });
		}

		// Agent 连上控制面后用 uv 创建 venv、下载安装 SDK，然后才发出 welcome。
		agent = await startRealAgent({
			grpcUrl: server.grpcUrl,
			name: "bundle-agent",
			bin: join(sflyHome, "bin", "sfly-agent"),
			welcomeTimeoutMs: 120_000,
		});
		expect(agent.events).toContainEqual({ event: "sdk_installed", version });

		const id = await api.orchestrationWith({
			default_agent: "bundle-agent",
			nodes: [
				{ id: "entry", kind: "entry" },
				{ id: "a", kind: "package", package: "sfly-stub", node: "echo", inputs: { text: "打包" } },
			],
			edges: [{ from: "entry", to: "a", kind: "chain" }],
			packages: { "sfly-stub": "0.1.0" },
		});
		const runId = await api.triggerOk(id);
		await eventually(async () => expect((await api.run(runId)).status).toBe("success"), 120_000);
		expect((await api.node(runId, "a")).outputs).toEqual({ text: "打包" });
	}, 300_000);
});
