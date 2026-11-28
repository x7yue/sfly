// sfly package list / show 的「最新版本」和控制台一样是控制面标出的那个（#434）：按版本号，不是最近发布的。
// 先发 1.10.0 再发 1.9.1：原来命令行取最近发布的 1.9.1，控制台按版本号算出 1.10.0，两边不一样。
import { strToU8 } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ManualClock } from "./support/manual-clock.js";
import { packageArchive, packageMetadata, publishInit } from "./support/package-archive.js";
import { sfly } from "./support/sfly-cli.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

describe("sfly package：最新版本按版本号（#434）", () => {
	let cp: TestControlPlane;
	const cli = (...args: string[]) => sfly([...args, "--server", cp.httpUrl]);

	beforeAll(async () => {
		cp = await startTestControlPlane();
		for (const version of ["1.10.0", "1.9.1"]) {
			const metadata = packageMetadata({ name: "bench", version });
			const res = await cp.fetch(
				"/projects/default/packages",
				publishInit(
					packageArchive(metadata, { [`bench-${version}-py3-none-any.whl`]: strToU8("w") }),
				),
			);
			expect(res.status).toBe(201);
			(cp.clock as ManualClock).advance(1000);
		}
	}, 60_000);
	afterAll(async () => {
		await cp?.close();
	});

	it("list 的 latest_version 和控制面的一样；show 不写版本时显示 1.10.0，标着最新版本", async () => {
		const list = await cli("package", "list", "--json");
		expect(list.code, list.stderr).toBe(0);
		const [bench] = JSON.parse(list.stdout) as { latest_version: string }[];
		expect(bench?.latest_version).toBe("1.10.0");

		const show = await cli("package", "show", "bench");
		expect(show.code, show.stderr).toBe(0);
		expect(show.stdout.split("\n")[0]).toMatch(/^节点包 bench@1\.10\.0（最新版本）/);
		const older = await cli("package", "show", "bench@1.9.1");
		expect(older.stdout.split("\n")[0]).not.toContain("最新版本");
	}, 60_000);
});
