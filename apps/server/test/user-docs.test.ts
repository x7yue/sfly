// 切入点 A：控制面提供用户文档原文 `/docs/<页>.md` 与索引 `/llms.txt`（ADR 0013，#60），
// 返回时把占位符替换成控制面地址和版本号。
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docsApi } from "@sfly/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoRoot } from "./support/agent-binary.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

describe("用户文档", () => {
	let dir: string;
	let cp: TestControlPlane;

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "sfly-docs-"));
		await writeFile(
			join(dir, "pages.json"),
			JSON.stringify({
				pages: [
					{ slug: "quickstart", title: "快速开始", description: "从零跑通一个节点" },
					{ slug: "publish", title: "发布", description: "构建并发布节点包" },
				],
			}),
		);
		await writeFile(
			join(dir, "quickstart.md"),
			"# 快速开始\n\n```sh\ncurl -fsSL {{SFLY_URL}}/install.sh | sh\n```\n\n版本 {{SFLY_VERSION}}，见 [发布](publish.md)。\n",
		);
		await writeFile(join(dir, "publish.md"), "# 发布\n");
		cp = await startTestControlPlane({ docsDir: dir, version: "1.2.3" });
	});
	afterAll(async () => {
		await cp?.close();
		await rm(dir, { recursive: true, force: true });
	});

	it("/docs/<页>.md 返回替换了占位符的 Markdown 原文", async () => {
		const res = await cp.fetch("/docs/quickstart.md");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
		expect(await res.text()).toBe(
			`# 快速开始\n\n\`\`\`sh\ncurl -fsSL ${cp.httpUrl}/install.sh | sh\n\`\`\`\n\n版本 1.2.3，见 [发布](publish.md)。\n`,
		);
		// 浏览器经 /api 前缀读取同一份内容（前端文档页）。
		expect(await (await cp.fetch("/api/docs/publish.md")).text()).toBe("# 发布\n");
	});

	it("未知页返回 404", async () => {
		const res = await cp.fetch("/docs/no-such-page.md");
		expect(res.status).toBe(404);
		expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
	});

	it("/llms.txt 列出全部页面的完整原文地址", async () => {
		const res = await cp.fetch("/llms.txt");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
		const text = await res.text();
		expect(text).toMatch(/^# sfly 开发文档\n/);
		expect(text).toContain(`- [快速开始](${cp.httpUrl}/docs/quickstart.md): 从零跑通一个节点\n`);
		expect(text).toContain(`- [发布](${cp.httpUrl}/docs/publish.md): 构建并发布节点包\n`);
	});

	it("文档目录按登记顺序列出页面（前端导航用）", async () => {
		const res = await cp.fetch("/docs");
		expect(docsApi.list.response.parse(await res.json())).toEqual({
			pages: [
				{ slug: "quickstart", title: "快速开始", description: "从零跑通一个节点" },
				{ slug: "publish", title: "发布", description: "构建并发布节点包" },
			],
		});
	});

	it("没有 skill 时 skill 原文返回 404，/llms.txt 不列 skill", async () => {
		expect((await cp.fetch("/docs/skills/sfly-node-dev/SKILL.md")).status).toBe(404);
		expect(await (await cp.fetch("/llms.txt")).text()).not.toContain("skill");
	});
});

describe("节点开发 skill 的原文", () => {
	let dir: string;
	let cp: TestControlPlane;

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "sfly-docs-skill-"));
		await writeFile(
			join(dir, "pages.json"),
			JSON.stringify({
				pages: [{ slug: "sdk-reference", title: "SDK 参考", description: "接口" }],
			}),
		);
		await writeFile(join(dir, "sdk-reference.md"), "# SDK 参考\n\n版本 {{SFLY_VERSION}}\n");
		await mkdir(join(dir, "skills", "sfly-node-dev"), { recursive: true });
		await writeFile(
			join(dir, "skills", "sfly-node-dev", "SKILL.md"),
			"---\nname: sfly-node-dev\n---\n\n见 [reference.md](reference.md)，控制面 {{SFLY_URL}}\n",
		);
		cp = await startTestControlPlane({ docsDir: dir, version: "1.2.3" });
	});
	afterAll(async () => {
		await cp?.close();
		await rm(dir, { recursive: true, force: true });
	});

	it("SKILL.md 与 reference.md（即 SDK 参考页）在同一个目录下，占位符已替换", async () => {
		const skill = await cp.fetch("/docs/skills/sfly-node-dev/SKILL.md");
		expect(skill.status).toBe(200);
		expect(skill.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
		expect(await skill.text()).toBe(
			`---\nname: sfly-node-dev\n---\n\n见 [reference.md](reference.md)，控制面 ${cp.httpUrl}\n`,
		);
		const reference = await cp.fetch("/docs/skills/sfly-node-dev/reference.md");
		expect(reference.status).toBe(200);
		expect(await reference.text()).toBe("# SDK 参考\n\n版本 1.2.3\n");
		// 浏览器经 /api 前缀读取同一份内容。
		expect((await cp.fetch("/api/docs/skills/sfly-node-dev/reference.md")).status).toBe(200);
		expect((await cp.fetch("/docs/skills/sfly-node-dev/other.md")).status).toBe(404);
		expect((await cp.fetch("/docs/skills/other/SKILL.md")).status).toBe(404);
	});

	it("/llms.txt 列出 skill 的原文地址", async () => {
		const text = await (await cp.fetch("/llms.txt")).text();
		expect(text).toContain(`(${cp.httpUrl}/docs/skills/sfly-node-dev/SKILL.md)`);
		expect(text).toContain(`(${cp.httpUrl}/docs/skills/sfly-node-dev/reference.md)`);
	});
});

describe("仓库里的用户文档", () => {
	it("每个登记的页面都能读到，没有未替换的占位符", async () => {
		const cp = await startTestControlPlane({ docsDir: join(repoRoot, "docs", "guide") });
		try {
			const { pages } = docsApi.list.response.parse(await (await cp.fetch("/docs")).json());
			expect(pages.map((p) => p.slug)).toContain("quickstart");
			const index = await (await cp.fetch("/llms.txt")).text();
			for (const { slug } of pages) {
				expect(index).toContain(`(${cp.httpUrl}/docs/${slug}.md)`);
				const res = await cp.fetch(`/docs/${slug}.md`);
				expect(res.status, slug).toBe(200);
				expect(await res.text(), slug).not.toMatch(/\{\{/);
			}
			// skill 的原文与 SDK wheel 里的内容出自同一份源文件（sdk/python/tests/test_skill.py）。
			const guide = join(repoRoot, "docs", "guide");
			for (const [file, source] of [
				["SKILL.md", join(guide, "skills", "sfly-node-dev", "SKILL.md")],
				["reference.md", join(guide, "sdk-reference.md")],
			] as const) {
				const res = await cp.fetch(`/docs/skills/sfly-node-dev/${file}`);
				expect(res.status, file).toBe(200);
				expect(await res.text(), file).toBe(await readFile(source, "utf8"));
			}
		} finally {
			await cp.close();
		}
	});

	it("按「安装 → 初始化 → 开发 → 本地调试 → 联调 → 发布 → 编排子流程 → 标准节点」排列全部页面，llms.txt 逐页列出，页面之间的链接都指向登记的页面", async () => {
		const cp = await startTestControlPlane({ docsDir: join(repoRoot, "docs", "guide") });
		try {
			const { pages } = docsApi.list.response.parse(await (await cp.fetch("/docs")).json());
			expect(pages.map((p) => [p.slug, p.title])).toEqual([
				["quickstart", "快速开始"],
				["install-agent", "安装 Agent"],
				["init-project", "初始化项目"],
				["sdk-reference", "开发节点（SDK 参考）"],
				["local-debug", "本地调试"],
				["integration", "联调"],
				["publish", "发布"],
				["subflows", "子流程与停止子流程"],
				["standard-nodes", "标准节点"],
				["ai-quickstart", "AI 编程助手快速开始"],
			]);
			const index = await (await cp.fetch("/llms.txt")).text();
			for (const { slug, title } of pages) {
				expect(index).toContain(`- [${title}](${cp.httpUrl}/docs/${slug}.md): `);
				const text = await (await cp.fetch(`/docs/${slug}.md`)).text();
				for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
					const page = /^([a-z0-9-]+)\.md(#.*)?$/.exec(target ?? "")?.[1];
					if (page)
						expect(
							pages.map((p) => p.slug),
							`${slug} → ${target}`,
						).toContain(page);
				}
			}
		} finally {
			await cp.close();
		}
	});

	it("文档里出现未知的占位符时控制面启动失败", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sfly-docs-bad-"));
		try {
			await writeFile(
				join(dir, "pages.json"),
				JSON.stringify({ pages: [{ slug: "a", title: "A", description: "a" }] }),
			);
			await writeFile(join(dir, "a.md"), "{{SFLY_TYPO}}\n");
			await expect(startTestControlPlane({ docsDir: dir })).rejects.toThrow(/SFLY_TYPO/);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
