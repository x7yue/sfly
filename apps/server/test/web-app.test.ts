import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const INDEX_HTML = '<!doctype html><html><body><div id="app"></div></body></html>';
const APP_JS = "console.log('sfly');";
/** 浏览器地址栏导航时的 Accept 请求头。 */
const NAVIGATE = { accept: "text/html,application/xhtml+xml,*/*;q=0.8" };

describe("控制面托管前端（SPA）", () => {
	let webDir: string;
	let cp: TestControlPlane | undefined;

	beforeAll(async () => {
		webDir = await mkdtemp(join(tmpdir(), "sfly-web-"));
		await mkdir(join(webDir, "assets"));
		await writeFile(join(webDir, "index.html"), INDEX_HTML);
		await writeFile(join(webDir, "assets", "app-abc123.js"), APP_JS);
	});
	afterAll(async () => {
		await rm(webDir, { recursive: true, force: true });
	});
	afterEach(async () => {
		await cp?.close();
		cp = undefined;
	});

	it("入口页、静态资源与 API 同端口提供", async () => {
		cp = await startTestControlPlane({ webDir });

		const index = await cp.fetch("/", { headers: NAVIGATE });
		expect(index.status).toBe(200);
		expect(index.headers.get("content-type")).toMatch(/^text\/html/);
		expect(await index.text()).toBe(INDEX_HTML);

		const asset = await cp.fetch("/assets/app-abc123.js");
		expect(asset.status).toBe(200);
		expect(asset.headers.get("content-type")).toMatch(/^text\/javascript/);
		expect(await asset.text()).toBe(APP_JS);

		const agents = await cp.fetch("/api/agents");
		expect(agents.status).toBe(200);
		expect(await agents.json()).toEqual({ agents: [], control_plane_version: cp.version });
	});

	it("浏览器导航到前端路由时回退到入口页，包括与 API 同名的路径", async () => {
		cp = await startTestControlPlane({ webDir });
		for (const path of ["/agents", "/orchestrations/abc/runs", "/no/such/page?x=1"]) {
			const res = await cp.fetch(path, { headers: NAVIGATE });
			expect(res.status, path).toBe(200);
			expect(await res.text(), path).toBe(INDEX_HTML);
		}
	});

	it("/api 下的路由不回退：浏览器经 /api 调用 API，未知路由返回 JSON 404", async () => {
		cp = await startTestControlPlane({ webDir });

		const created = await cp.fetch("/api/orchestrations", {
			method: "POST",
			headers: { "content-type": "application/json", "x-sfly-nickname": "tester" },
			body: JSON.stringify({ name: "冒烟" }),
		});
		expect(created.status).toBe(201);
		const { id } = (await created.json()) as { id: string };
		const fetched = await cp.fetch(`/api/orchestrations/${id}`, { headers: NAVIGATE });
		expect(fetched.status).toBe(200);
		expect(await fetched.json()).toMatchObject({ id, name: "冒烟" });

		const missing = await cp.fetch("/api/no/such/route", { headers: NAVIGATE });
		expect(missing.status).toBe(404);
		expect(await missing.json()).toMatchObject({ error: { code: "not_found" } });
	});

	it("Agent、CLI 等非浏览器客户端访问根路径上的 API 不受影响", async () => {
		cp = await startTestControlPlane({ webDir });
		const agents = await cp.fetch("/agents");
		expect(await agents.json()).toEqual({ agents: [], control_plane_version: cp.version });
		const missing = await cp.fetch("/no/such/route");
		expect(missing.status).toBe(404);
		expect(await missing.json()).toMatchObject({ error: { code: "not_found" } });
	});

	it("浏览器打开文档原文与 llms.txt 时得到原文，不回退到入口页", async () => {
		const docsDir = await mkdtemp(join(tmpdir(), "sfly-web-docs-"));
		try {
			await writeFile(
				join(docsDir, "pages.json"),
				JSON.stringify({ pages: [{ slug: "quickstart", title: "快速开始", description: "d" }] }),
			);
			await writeFile(join(docsDir, "quickstart.md"), "# 快速开始\n");
			cp = await startTestControlPlane({ webDir, docsDir });
			const page = await cp.fetch("/docs/quickstart.md", { headers: NAVIGATE });
			expect(await page.text()).toBe("# 快速开始\n");
			const index = await cp.fetch("/llms.txt", { headers: NAVIGATE });
			expect(await index.text()).toMatch(/^# sfly 开发文档/);
			// 前端的文档页仍然回退到入口页。
			expect(await (await cp.fetch("/docs/quickstart", { headers: NAVIGATE })).text()).toBe(
				INDEX_HTML,
			);
		} finally {
			await rm(docsDir, { recursive: true, force: true });
		}
	});

	it("没有配置前端目录时不提供页面", async () => {
		cp = await startTestControlPlane();
		const res = await cp.fetch("/", { headers: NAVIGATE });
		expect(res.status).toBe(404);
		expect((await cp.fetch("/api/agents")).status).toBe(200);
	});
});
