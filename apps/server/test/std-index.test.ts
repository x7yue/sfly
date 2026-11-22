// 控制面的包索引里的标准节点包 sfly-std（#556）：`/simple/sfly-std/` 列出公共项目里已发布的 sfly-std 的 wheel
// （PEP 503，链接带 sha256），wheel 取自节点包归档；不列任何别的项目、别的名字的包。名字一直有回应：还没有发布时是一个没有
// 版本的页面而不是 404，所以 uv 不会转去 PyPI 取一个同名的包（agent/tests/package_index.rs）。
import { createHash } from "node:crypto";
import { strToU8 } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { packageArchive, packageMetadata, publishInit } from "./support/package-archive.js";
import { publishIntoPublicProject } from "./support/std-package.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

/** 一个节点包归档，里面的 wheel 内容是 `wheel <名> <版本>`（控制面只看文件名，不必是真的 wheel）。 */
function archiveOf(name: string, version: string, wheelName = name.replace(/-/g, "_")) {
	const filename = `${wheelName}-${version}-py3-none-any.whl`;
	return {
		filename,
		wheel: `wheel ${name} ${version}`,
		archive: packageArchive(packageMetadata({ name, version, requires_python: ">=3.10" }), {
			[filename]: strToU8(`wheel ${name} ${version}`),
		}),
	};
}

describe("sfly-std 在控制面的包索引里", () => {
	let cp: TestControlPlane;

	beforeAll(async () => {
		cp = await startTestControlPlane({ version: "1.2.3" });
	});
	afterAll(async () => {
		await cp?.close();
	});

	const links = (html: string) =>
		[...html.matchAll(/<a href="([^"]*)"([^>]*)>([^<]*)<\/a>/g)].map(
			([, href, attributes, text]) => ({ href, attributes: attributes?.trim(), text }),
		);

	it("根页面列出 sfly 和 sfly-std 两个项目", async () => {
		const res = await cp.fetch("/simple/");
		expect(res.status).toBe(200);
		expect(links(await res.text()).map((l) => l.text)).toEqual(["sfly", "sfly-std"]);
	});

	it("还没有发布时项目页仍然是 200，只是没有任何版本（不是 404，uv 才不会去 PyPI 找同名的包）", async () => {
		const res = await cp.fetch("/simple/sfly-std/");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toMatch(/^text\/html/);
		expect(res.headers.get("cache-control")).toBe("no-cache");
		expect(links(await res.text())).toEqual([]);
	});

	it("项目名按 PEP 503 规范化", async () => {
		for (const name of ["SFLY-STD", "sfly_std", "Sfly.Std"]) {
			expect((await cp.fetch(`/simple/${name}/`)).status, name).toBe(200);
		}
	});

	describe("公共项目里发布了 sfly-std 之后", () => {
		const older = archiveOf("sfly-std", "0.3.0");
		const newer = archiveOf("sfly-std", "0.4.0");
		const own = archiveOf("sfly-std", "0.9.0"); // 默认项目里发布的
		const other = archiveOf("sfly-std-extras", "1.0.0"); // 公共项目里别的名字

		beforeAll(async () => {
			await publishIntoPublicProject(cp, older.archive, { name: "sfly-std", version: "0.3.0" });
			await publishIntoPublicProject(cp, newer.archive, { name: "sfly-std", version: "0.4.0" });
			await publishIntoPublicProject(cp, other.archive, {
				name: "sfly-std-extras",
				version: "1.0.0",
			});
			const res = await cp.fetch("/packages", publishInit(own.archive));
			expect(res.status).toBe(201);
		});

		it("项目页按发布的先后列出公共项目里每个版本的 wheel：链接带 wheel 的 sha256，写明 requires-python", async () => {
			const res = await cp.fetch("/simple/sfly-std/");
			expect(links(await res.text())).toEqual([
				{
					href: `${cp.httpUrl}/simple/sfly-std/files/${older.filename}#sha256=${sha256(older.wheel)}`,
					attributes: 'data-requires-python="&gt;=3.10"',
					text: older.filename,
				},
				{
					href: `${cp.httpUrl}/simple/sfly-std/files/${newer.filename}#sha256=${sha256(newer.wheel)}`,
					attributes: 'data-requires-python="&gt;=3.10"',
					text: newer.filename,
				},
			]);
		});

		it("链接指向的 wheel 就是归档里的 wheel，内容和链接里的 sha256 一致", async () => {
			const [link] = links(await (await cp.fetch("/simple/sfly-std/")).text());
			const wheel = await fetch((link?.href ?? "").split("#")[0] as string);
			expect(wheel.status).toBe(200);
			expect(wheel.headers.get("content-type")).toBe("application/octet-stream");
			expect(await wheel.text()).toBe(older.wheel);
		});

		it("别的项目里发布的 sfly-std 版本不在索引里，下载它的文件名得到 404", async () => {
			const html = await (await cp.fetch("/simple/sfly-std/")).text();
			expect(html).not.toContain("0.9.0");
			expect((await cp.fetch(`/simple/sfly-std/files/${own.filename}`)).status).toBe(404);
		});

		it("公共项目里别的名字的包不在索引里：项目页、下载都是 404，根页面也不列", async () => {
			expect((await cp.fetch("/simple/sfly-std-extras/")).status).toBe(404);
			expect((await cp.fetch(`/simple/sfly-std/files/${other.filename}`)).status).toBe(404);
			expect(links(await (await cp.fetch("/simple/")).text()).map((l) => l.text)).toEqual([
				"sfly",
				"sfly-std",
			]);
		});

		it("下载不存在的文件名、不是 wheel 的文件名、带路径的文件名都是 404", async () => {
			for (const name of [
				"sfly_std-9.9.9-py3-none-any.whl",
				"sfly_std-0.3.0.tar.gz",
				"..%2F..%2Fetc%2Fpasswd",
			]) {
				expect((await cp.fetch(`/simple/sfly-std/files/${name}`)).status, name).toBe(404);
			}
		});

		it("归档里的 wheel 不是 sfly_std 的（元信息写的名字和 wheel 对不上）时不列出", async () => {
			const odd = archiveOf("sfly-std", "0.5.0", "some_other_dist");
			await publishIntoPublicProject(cp, odd.archive, { name: "sfly-std", version: "0.5.0" });
			const html = await (await cp.fetch("/simple/sfly-std/")).text();
			expect(html).not.toContain("some_other_dist");
			expect(links(html)).toHaveLength(2);
			expect((await cp.fetch(`/simple/sfly-std/files/${odd.filename}`)).status).toBe(404);
		});
	});
});
