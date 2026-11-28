// 节点包列表标出公共项目里的包（#501）：控制台把它们单独列出来。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { packageArchive, packageMetadata, publishInit } from "./support/package-archive.js";
import { publishIntoPublicProject } from "./support/std-package.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

describe("节点包列表里的 public（#501）", () => {
	let cp: TestControlPlane;
	const archive = (name: string) => packageArchive(packageMetadata({ name, version: "1.0.0" }));

	beforeAll(async () => {
		cp = await startTestControlPlane();
		await publishIntoPublicProject(cp, archive("sfly-std"), { name: "sfly-std", version: "1.0.0" });
		expect(
			(await cp.fetch("/projects/default/packages", publishInit(archive("my-checks")))).status,
		).toBe(201);
	});
	afterAll(async () => {
		await cp?.close();
	});

	it("公共项目里的包 public 为 true，本项目发布的为 false；列表和按名字取一样", async () => {
		const { packages } = (await (await cp.fetch("/projects/default/packages")).json()) as {
			packages: { name: string; public: boolean }[];
		};
		expect(packages.map(({ name, public: p }) => [name, p])).toEqual([
			["my-checks", false],
			["sfly-std", true],
		]);
		for (const [name, expected] of [
			["sfly-std", true],
			["my-checks", false],
		] as const) {
			const pkg = (await (await cp.fetch(`/projects/default/packages/${name}`)).json()) as {
				public: boolean;
			};
			expect(pkg.public, name).toBe(expected);
		}
	});
});
