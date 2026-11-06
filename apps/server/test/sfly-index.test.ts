// 切入点 A：控制面的 sfly 简单索引（PEP 503）。只列出 `sfly` 项目和与控制面同版本的 SDK wheel，
// 开发机用 `uv tool install` / 项目的显式索引从这里装 `sfly`，不会从 PyPI 镜像装到同名的其他包。
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

describe("sfly 简单索引", () => {
	let cp: TestControlPlane;
	let dir: string;

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "sfly-index-"));
		// 控制面只看文件名识别 wheel，内容不必是真的 wheel。
		await writeFile(join(dir, "sfly-1.2.3-py3-none-any.whl"), "wheel 1.2.3");
		await writeFile(join(dir, "sfly-1.2.2-py3-none-any.whl"), "wheel 1.2.2");
		cp = await startTestControlPlane({ version: "1.2.3", sdkWheelDir: dir });
	});
	afterAll(async () => {
		await cp?.close();
		await rm(dir, { recursive: true, force: true });
	});

	const links = (html: string) =>
		[...html.matchAll(/<a href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map(([, href, text]) => ({
			href,
			text,
		}));

	it("根页面只列出 sfly 项目", async () => {
		const res = await cp.fetch("/simple/");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toMatch(/^text\/html/);
		expect(links(await res.text())).toEqual([{ href: "sfly/", text: "sfly" }]);
	});

	it("项目页只列出与控制面同版本的 wheel，链接带 sha256", async () => {
		const res = await cp.fetch("/simple/sfly/");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toMatch(/^text\/html/);
		expect(res.headers.get("cache-control")).toBe("no-cache");
		const [link, ...rest] = links(await res.text());
		expect(rest).toEqual([]);
		expect(link).toEqual({
			href: `${cp.httpUrl}/sdk/python/1.2.3/sfly-1.2.3-py3-none-any.whl#sha256=${sha256("wheel 1.2.3")}`,
			text: "sfly-1.2.3-py3-none-any.whl",
		});
		const wheel = await fetch((link?.href ?? "").split("#")[0] as string);
		expect(await wheel.text()).toBe("wheel 1.2.3");
	});

	it("项目名按 PEP 503 规范化", async () => {
		expect((await cp.fetch("/simple/SFLY/")).status).toBe(200);
	});

	it("未知项目返回 404", async () => {
		expect((await cp.fetch("/simple/requests/")).status).toBe(404);
		expect((await cp.fetch("/simple/sfly-stub/")).status).toBe(404);
	});
});
