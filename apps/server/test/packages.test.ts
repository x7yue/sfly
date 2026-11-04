import { createHash } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { ManualClock } from "./support/manual-clock.js";
import { packageArchive, packageMetadata, publishInit } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

describe("节点包仓库", () => {
	let cp: TestControlPlane | undefined;
	afterEach(async () => {
		await cp?.close();
		cp = undefined;
	});

	it("发布节点包后可以查询包、版本和节点类型元信息，并下载原始归档", async () => {
		cp = await startTestControlPlane();
		const archive = packageArchive();

		const res = await cp.fetch("/packages", publishInit(archive));
		expect(res.status).toBe(201);
		const published = await res.json();
		expect(published).toEqual({
			name: "demo-checks",
			version: "1.2.0",
			sha256: sha256(archive),
			size: archive.byteLength,
			published_at: "2026-01-01T00:00:00.000Z",
			metadata: packageMetadata(),
		});

		const list = (await (await cp.fetch("/packages")).json()) as { packages: unknown[] };
		expect(list).toEqual({
			packages: [
				{
					name: "demo-checks",
					versions: [
						{
							version: "1.2.0",
							sha256: sha256(archive),
							size: archive.byteLength,
							published_at: "2026-01-01T00:00:00.000Z",
							nodes: [
								{ name: "http_check", title: "HTTP 检查" },
								{ name: "ping", title: "ping" },
							],
						},
					],
				},
			],
		});

		const pkg = await cp.fetch("/packages/demo-checks");
		expect(pkg.status).toBe(200);
		expect(await pkg.json()).toEqual(list.packages[0]);

		const version = await cp.fetch("/packages/demo-checks/versions/1.2.0");
		expect(version.status).toBe(200);
		expect(await version.json()).toEqual(published);

		const nodeType = await cp.fetch("/packages/demo-checks/versions/1.2.0/nodes/http_check");
		expect(nodeType.status).toBe(200);
		expect(await nodeType.json()).toEqual((packageMetadata().nodes as unknown[])[0]);

		const download = await cp.fetch("/packages/demo-checks/versions/1.2.0/archive");
		expect(download.status).toBe(200);
		expect(download.headers.get("x-sfly-sha256")).toBe(sha256(archive));
		expect(new Uint8Array(await download.arrayBuffer())).toEqual(archive);
	});

	it("列出多个包和版本：包按名称排序，版本按发布时间从新到旧", async () => {
		const clock = new ManualClock();
		cp = await startTestControlPlane({ clock });
		for (const [name, version] of [
			["zeta", "1.0.0"],
			["alpha", "0.1.0"],
			["alpha", "0.2.0"],
		] as const) {
			const res = await cp.fetch(
				"/packages",
				publishInit(packageArchive(packageMetadata({ name, version }))),
			);
			expect(res.status).toBe(201);
			clock.advance(1000);
		}

		const { packages } = (await (await cp.fetch("/packages")).json()) as {
			packages: { name: string; versions: { version: string; published_at: string }[] }[];
		};
		expect(packages.map((p) => p.name)).toEqual(["alpha", "zeta"]);
		expect(packages[0]?.versions.map((v) => [v.version, v.published_at])).toEqual([
			["0.2.0", "2026-01-01T00:00:02.000Z"],
			["0.1.0", "2026-01-01T00:00:01.000Z"],
		]);
	});

	it("同名同版本已存在时拒绝发布，已发布的文件不被覆盖", async () => {
		cp = await startTestControlPlane();
		const first = packageArchive();
		expect((await cp.fetch("/packages", publishInit(first))).status).toBe(201);

		const second = packageArchive(packageMetadata({ requires_python: ">=3.12" }));
		const res = await cp.fetch("/packages", publishInit(second));
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({
			error: "conflict",
			message: expect.stringContaining("demo-checks@1.2.0"),
		});

		const download = await cp.fetch("/packages/demo-checks/versions/1.2.0/archive");
		expect(new Uint8Array(await download.arrayBuffer())).toEqual(first);
		const version = (await (await cp.fetch("/packages/demo-checks/versions/1.2.0")).json()) as {
			metadata: { requires_python: string };
		};
		expect(version.metadata.requires_python).toBe(">=3.10");
	});

	it.each([
		["不是 zip", strToU8("not a zip")],
		["缺少 sfly-package.json", zipSync({ "a.whl": strToU8("a") })],
		["元信息不是 JSON", zipSync({ "sfly-package.json": strToU8("{"), "a.whl": strToU8("a") })],
		["元信息未通过 schema 校验", packageArchive(packageMetadata({ name: "Demo Checks" }))],
		["版本号不合法", packageArchive(packageMetadata({ version: "../1.0" }))],
		["节点列表为空", packageArchive(packageMetadata({ nodes: [] }))],
		["没有 wheel", packageArchive(packageMetadata(), {})],
		[
			"多个 wheel",
			packageArchive(packageMetadata(), { "a.whl": strToU8("a"), "b.whl": strToU8("b") }),
		],
		[
			"节点名重复",
			packageArchive(
				packageMetadata({
					nodes: [
						(packageMetadata().nodes as unknown[])[0],
						(packageMetadata().nodes as unknown[])[0],
					],
				}),
			),
		],
	])("拒绝无效的节点包：%s", async (_label, archive) => {
		cp = await startTestControlPlane();
		const res = await cp.fetch("/packages", publishInit(archive));
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: "invalid_package" });
		expect(await (await cp.fetch("/packages")).json()).toEqual({ packages: [] });
	});

	it("控制面重启后节点包和文件仍然可用", async () => {
		cp = await startTestControlPlane();
		const archive = packageArchive();
		expect((await cp.fetch("/packages", publishInit(archive))).status).toBe(201);

		await cp.restart();

		const download = await cp.fetch("/packages/demo-checks/versions/1.2.0/archive");
		expect(new Uint8Array(await download.arrayBuffer())).toEqual(archive);
		expect((await cp.fetch("/packages", publishInit(archive))).status).toBe(409);
	});

	it("查询不存在的包、版本、节点类型时返回 404", async () => {
		cp = await startTestControlPlane();
		expect((await cp.fetch("/packages", publishInit(packageArchive()))).status).toBe(201);

		for (const path of [
			"/packages/missing",
			"/packages/demo-checks/versions/9.9.9",
			"/packages/demo-checks/versions/9.9.9/archive",
			"/packages/demo-checks/versions/1.2.0/nodes/missing",
		]) {
			const res = await cp.fetch(path);
			expect(res.status, path).toBe(404);
			expect(await res.json(), path).toMatchObject({ error: "not_found" });
		}
	});
});
