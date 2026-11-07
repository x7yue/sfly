import { execFile } from "node:child_process";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { repoRoot } from "./agent-binary.js";

const run = promisify(execFile);

/** 构建出的标准节点包 sfly-std（std/，ADR 0017）。 */
export interface StdPackage {
	/** `.sflypkg` 的路径。 */
	path: string;
	/** 文件名 `sfly-std-<版本>.sflypkg`。 */
	file: string;
	version: string;
}

/** 用真实的 sfly CLI 构建 sfly-std（与发布流程 scripts/release/std.sh 相同的 `sfly build std`）。 */
export async function buildStdPackage(out: string): Promise<StdPackage> {
	await run("uv", ["run", "--locked", "--quiet", "sfly", "build", "std", "--out", out], {
		cwd: repoRoot,
	});
	const file = (await readdir(out)).find((f) => /^sfly-std-.+\.sflypkg$/.test(f));
	if (!file) throw new Error(`sfly build std 没有在 ${out} 生成 sfly-std-*.sflypkg`);
	const version = file.replace(/^sfly-std-/, "").replace(/\.sflypkg$/, "");
	return { path: join(out, file), file, version };
}

/**
 * PyPI 镜像桩（support/pypi-stub.ts）用的 wheel：`requirements` 及其全部依赖，取自测试环境里已安装的发行版
 * 重新打包（sdk/python/tests/indexes.py 的 wheelhouse），不访问外网。`withStdDependencies` 时加上 sfly-std 的
 * 全部依赖（工作区里装着 sfly-std，依赖列表取自它的元信息，新增依赖不用改这里）。
 */
export async function wheelhouse(
	dir: string,
	requirements: string[],
	options: { withStdDependencies?: boolean } = {},
): Promise<Array<[project: string, filename: string, body: Uint8Array]>> {
	await mkdir(dir, { recursive: true });
	await run(
		"uv",
		[
			"run",
			"--locked",
			"--quiet",
			"python",
			"-c",
			"import json, sys; from importlib.metadata import requires; from pathlib import Path; " +
				"from indexes import wheelhouse; reqs = json.loads(sys.argv[2]); " +
				"reqs += (requires('sfly-std') or []) if sys.argv[3] == '1' else []; " +
				"wheelhouse(reqs, Path(sys.argv[1]))",
			dir,
			JSON.stringify(requirements),
			options.withStdDependencies ? "1" : "0",
		],
		{ cwd: repoRoot, env: { ...process.env, PYTHONPATH: join(repoRoot, "sdk/python/tests") } },
	);
	const files = await readdir(dir);
	return Promise.all(
		files.map(
			async (file) =>
				[file.split("-")[0] as string, file, await readFile(join(dir, file))] as [
					string,
					string,
					Uint8Array,
				],
		),
	);
}
