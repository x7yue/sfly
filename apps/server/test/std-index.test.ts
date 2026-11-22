// 控制面的包索引里的标准节点包 sfly-std（#556）：`/simple/sfly-std/` 列出公共项目里已发布的 sfly-std 的 wheel
// （PEP 503，链接带 sha256），wheel 取自节点包归档；不列任何别的项目、别的名字的包。名字一直有回应：还没有发布时是一个没有
// 版本的页面而不是 404，所以 uv 不会转去 PyPI 取一个同名的包（agent/tests/package_index.rs）。
import { createHash } from "node:crypto";
import { strToU8 } from "fflate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { packageArchive, packageMetadata, publishInit } from "./support/package-archive.js";
import { publishIntoPublicProject } from "./support/std-package.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

/**
 * 一个节点包归档，里面的 wheel 内容是 `wheel <名> <版本>`（控制面只看文件名，不必是真的 wheel）。
 * `wheelVersion` 是 wheel 文件名里的版本，默认和归档登记的版本一样。
 */
function archiveOf(
	name: string,
	version: string,
	wheelName = name.replace(/-/g, "_"),
	wheelVersion = version,
) {
	const filename = `${wheelName}-${wheelVersion}-py3-none-any.whl`;
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

describe("wheel 要和归档登记的名字、版本对得上", () => {
	let cp: TestControlPlane;

	beforeAll(async () => {
		cp = await startTestControlPlane({ version: "1.2.3" });
	});
	afterAll(async () => {
		await cp?.close();
	});

	const names = async () =>
		[...(await (await cp.fetch("/simple/sfly-std/")).text()).matchAll(/>([^<]*\.whl)</g)].map(
			(m) => m[1],
		);

	it("归档登记 0.6.0、wheel 却是 7.0.0 的：不列，下载它的文件名得到 404（uv 从文件名读版本，列了就会装上 7.0.0）", async () => {
		const good = archiveOf("sfly-std", "0.5.0");
		const lying = archiveOf("sfly-std", "0.6.0", "sfly_std", "7.0.0");
		await publishIntoPublicProject(cp, good.archive, { name: "sfly-std", version: "0.5.0" });
		await publishIntoPublicProject(cp, lying.archive, { name: "sfly-std", version: "0.6.0" });

		expect(await names()).toEqual([good.filename]);
		expect((await cp.fetch(`/simple/sfly-std/files/${lying.filename}`)).status).toBe(404);
	});

	it("版本的写法不同但是同一个版本（0.7.0-beta.1 和 0.7.0b1）照样列出", async () => {
		const spelled = archiveOf("sfly-std", "0.7.0-beta.1", "sfly_std", "0.7.0b1");
		await publishIntoPublicProject(cp, spelled.archive, {
			name: "sfly-std",
			version: "0.7.0-beta.1",
		});

		expect(await names()).toContain(spelled.filename);
		expect((await cp.fetch(`/simple/sfly-std/files/${spelled.filename}`)).status).toBe(200);
	});

	it("两个归档里是同名的 wheel（版本写法不同的 0.8 和 0.8.0）：只列第一个，页上没有两条同名的链接", async () => {
		const first = archiveOf("sfly-std", "0.8", "sfly_std", "0.8.0");
		const second = archiveOf("sfly-std", "0.8.0");
		// 内容不同：第二个归档的 wheel 内容不是第一个的。
		const different = {
			...second,
			archive: packageArchive(
				packageMetadata({ name: "sfly-std", version: "0.8.0", requires_python: ">=3.10" }),
				{ [second.filename]: strToU8("另一份内容") },
			),
		};
		await publishIntoPublicProject(cp, first.archive, { name: "sfly-std", version: "0.8" });
		await publishIntoPublicProject(cp, different.archive, { name: "sfly-std", version: "0.8.0" });

		const listed = (await names()).filter((n) => n === first.filename);
		expect(listed).toHaveLength(1);
		const download = await cp.fetch(`/simple/sfly-std/files/${first.filename}`);
		expect(await download.text()).toBe(first.wheel);
	});
});

describe("读索引出错不能变成 404", () => {
	// 出错时回 404，uv 会把它当成「控制面没有这个包」转去 PyPI 取同名的包（first-index），所以必须是 5xx：uv 重试后失败。
	let cp: TestControlPlane;

	beforeAll(async () => {
		cp = await startTestControlPlane({ version: "1.2.3" });
		const std = archiveOf("sfly-std", "0.3.0");
		await publishIntoPublicProject(cp, std.archive, { name: "sfly-std", version: "0.3.0" });
	});
	afterAll(async () => {
		await cp?.close();
	});

	it("数据库查询失败时，项目页和 wheel 下载都是 500，恢复后照常", async () => {
		const wheel = "sfly_std-0.3.0-py3-none-any.whl";
		const db = new pg.Client({ connectionString: cp.database.url });
		await db.connect();
		try {
			await db.query("alter table node_packages rename to node_packages_hidden");
			try {
				for (const path of ["/simple/sfly-std/", `/simple/sfly-std/files/${wheel}`]) {
					const res = await cp.fetch(path);
					expect(res.status, path).toBe(500);
					expect(await res.text(), path).not.toContain(wheel);
				}
			} finally {
				await db.query("alter table node_packages_hidden rename to node_packages");
			}
		} finally {
			await db.end();
		}
		expect((await cp.fetch("/simple/sfly-std/")).status).toBe(200);
		expect((await cp.fetch(`/simple/sfly-std/files/${wheel}`)).status).toBe(200);
	});
});
