// API 客户端安装包（ADR 0022）：打成包管理器可以直接安装的 tarball，控制面提供它的列表与下载，和 SDK wheel 对称。
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoRoot } from "./support/agent-binary.js";

describe("API 客户端安装包", () => {
	let dir: string;
	let tarball: string;

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "sfly-client-"));
		execFileSync("pnpm", ["--filter", "@sfly/client", "run", "tarball", dir], {
			cwd: repoRoot,
			stdio: ["ignore", "ignore", "inherit"],
		});
		const names = (await readdir(dir)).filter((f) => f.endsWith(".tgz"));
		expect(names).toHaveLength(1);
		tarball = join(dir, names[0] as string);
	}, 60_000);
	afterAll(() => rm(dir, { recursive: true, force: true }));

	it("安装包里有类型声明，没有运行时依赖", () => {
		const files = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).split("\n");
		const manifest = JSON.parse(
			execFileSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" }),
		);

		const entry = manifest.exports["."];
		expect(files).toContain(`package/${entry.types.replace("./", "")}`);
		expect(files).toContain(`package/${entry.default.replace("./", "")}`);
		expect(entry.types).toMatch(/\.d\.ts$/);
		for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
			expect(manifest[field], field).toBeUndefined();
		}
	});
});
