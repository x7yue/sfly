import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect } from "vitest";
import { repoRoot } from "./agent-binary.js";
import type { TestControlPlane } from "./test-control-plane.js";

const run = promisify(execFile);

/** 用真实的 sfly CLI 构建桩节点包（testdata/stub-package，sfly-stub@0.1.0），经 HTTP API 发布。 */
export async function publishStubPackage(cp: TestControlPlane): Promise<void> {
	await publishTestPackage(cp, "testdata/stub-package", "sfly-stub-0.1.0.sflypkg");
}

/** 用真实的 sfly CLI 构建仓库里的一个测试节点包（`project` 相对仓库根目录，`file` 是构建出的归档名），经 HTTP API 发布。 */
export async function publishTestPackage(
	cp: TestControlPlane,
	project: string,
	file: string,
): Promise<void> {
	const out = await mkdtemp(join(tmpdir(), "sfly-test-pkg-"));
	try {
		await run("uv", ["run", "--locked", "--quiet", "sfly", "build", project, "--out", out], {
			cwd: repoRoot,
		});
		await publishArchive(cp, await readFile(join(out, file)));
	} finally {
		await rm(out, { recursive: true, force: true });
	}
}

/**
 * 用 `sfly build` 把桩节点源码（testdata/stub-package 的全部节点）按指定的包名、版本和依赖构建成
 * `.sflypkg`，返回归档内容（安装 / 依赖冲突场景用）。
 */
export async function buildStubPackage(
	name: string,
	version: string,
	dependencies: string[] = [],
): Promise<Uint8Array> {
	const dir = await mkdtemp(join(tmpdir(), "sfly-stub-build-"));
	try {
		const src = join(dir, "project", "src", name.replace(/-/g, "_"));
		await mkdir(src, { recursive: true });
		await copyFile(
			join(repoRoot, "testdata/stub-package/src/sfly_stub/__init__.py"),
			join(src, "__init__.py"),
		);
		await writeFile(
			join(dir, "project", "pyproject.toml"),
			`[project]\nname = "${name}"\nversion = "${version}"\ndependencies = ${JSON.stringify(dependencies)}\n`,
		);
		await run(
			"uv",
			[
				"run",
				"--locked",
				"--quiet",
				"sfly",
				"build",
				join(dir, "project"),
				"--out",
				join(dir, "out"),
			],
			{ cwd: repoRoot },
		);
		return await readFile(join(dir, "out", `${name}-${version}.sflypkg`));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** 经 HTTP API 发布一个节点包归档。 */
export async function publishArchive(cp: TestControlPlane, archive: Uint8Array): Promise<void> {
	const res = await cp.fetch("/packages", {
		method: "POST",
		headers: { "content-type": "application/octet-stream" },
		body: archive,
	});
	expect(res.status, await res.clone().text()).toBe(201);
}
