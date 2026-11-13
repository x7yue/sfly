// API 客户端安装包（ADR 0022）：打成包管理器可以直接安装的 tarball，控制面提供它的列表与下载。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoRoot } from "./support/agent-binary.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

describe("API 客户端安装包", () => {
	let dir: string;
	let tarball: { name: string; bytes: Buffer; sha256: string; version: string };
	let cp: TestControlPlane;

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "sfly-client-"));
		execFileSync("pnpm", ["--filter", "@sfly/client", "run", "tarball", dir], {
			cwd: repoRoot,
			stdio: ["ignore", "ignore", "inherit"],
		});
		const [name] = (await readdir(dir)).filter((f) => f.endsWith(".tgz"));
		if (!name) throw new Error("tarball 脚本没有产出安装包");
		const bytes = await readFile(join(dir, name));
		tarball = {
			name,
			bytes,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			version: name.replace(/^sfly-client-|\.tgz$/g, ""),
		};
		await writeFile(join(dir, "notes.txt"), "不是安装包");
		cp = await startTestControlPlane({ clientPackageDir: dir });
	}, 60_000);
	afterAll(async () => {
		await cp.close();
		await rm(dir, { recursive: true, force: true });
	});

	it("安装包里有类型声明，没有运行时依赖", () => {
		const path = join(dir, tarball.name);
		const files = execFileSync("tar", ["-tzf", path], { encoding: "utf8" }).split("\n");
		const manifest = JSON.parse(
			execFileSync("tar", ["-xzOf", path, "package/package.json"], { encoding: "utf8" }),
		);

		const entry = manifest.exports["."];
		expect(files).toContain(`package/${entry.types.replace("./", "")}`);
		expect(files).toContain(`package/${entry.default.replace("./", "")}`);
		expect(entry.types).toMatch(/\.d\.ts$/);
		for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
			expect(manifest[field], field).toBeUndefined();
		}
	});

	it("列出可下载的版本，可以按版本下载安装包；目录里的其他文件不算", async () => {
		const url = `${cp.httpUrl}/client/${tarball.version}/${tarball.name}`;
		expect(await (await cp.fetch("/client")).json()).toEqual({
			tarballs: [{ version: tarball.version, filename: tarball.name, sha256: tarball.sha256, url }],
		});

		const res = await fetch(url);
		expect(res.status).toBe(200);
		expect(Buffer.from(await res.arrayBuffer()).equals(tarball.bytes)).toBe(true);
		expect((await cp.fetch(`/client/9.9.9/${tarball.name}`)).status).toBe(404);
		expect((await cp.fetch(`/client/${tarball.version}/other.tgz`)).status).toBe(404);
		expect((await cp.fetch(`/client/${tarball.version}/notes.txt`)).status).toBe(404);
	});

	it.each([
		["没有配置目录", undefined],
		["目录不存在", join(tmpdir(), "sfly-client-missing")],
	])("%s：列表为空，控制面照常启动", async (_name, clientPackageDir) => {
		const empty = await startTestControlPlane({ clientPackageDir });
		try {
			expect(await (await empty.fetch("/client")).json()).toEqual({ tarballs: [] });
			expect((await empty.fetch(`/client/${tarball.version}/${tarball.name}`)).status).toBe(404);
			expect((await empty.fetch("/health")).status).toBe(200);
		} finally {
			await empty.close();
		}
	});
});
