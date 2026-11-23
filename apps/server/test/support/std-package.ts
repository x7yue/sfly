import { execFile } from "node:child_process";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { repoRoot } from "./agent-binary.js";
import { bearer, TestAccounts } from "./credentials.js";
import { publishInit } from "./package-archive.js";
import type { TestControlPlane } from "./test-control-plane.js";

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
 * 构建 sfly-std 的另一个版本（版本锁定的场景用）：把 std/ 的源码复制到 `out/project`，改版本号并按 `edits`
 * （相对 std/ 的文件、原文、替换为）修改源码后用 `sfly build` 构建到 `out`。原文找不到时报错，不会悄悄构建出没改的包。
 */
export async function buildStdPackageVariant(
	out: string,
	options: { version: string; edits?: Array<[file: string, from: string, to: string]> },
): Promise<StdPackage> {
	const project = join(out, "project");
	await mkdir(project, { recursive: true });
	await cp(join(repoRoot, "std/pyproject.toml"), join(project, "pyproject.toml"));
	await cp(join(repoRoot, "std/src"), join(project, "src"), {
		recursive: true,
		filter: (src) => !src.includes("__pycache__"),
	});
	const edit = async (file: string, from: string | RegExp, to: string) => {
		const path = join(project, file);
		const text = await readFile(path, "utf8");
		const edited = text.replace(from, to);
		if (edited === text) throw new Error(`${file} 里找不到 ${from}`);
		await writeFile(path, edited);
	};
	await edit("pyproject.toml", /^version = ".*"$/m, `version = "${options.version}"`);
	for (const [file, from, to] of options.edits ?? []) await edit(file, from, to);
	await run("uv", ["run", "--locked", "--quiet", "sfly", "build", project, "--out", out], {
		cwd: repoRoot,
	});
	const file = `sfly-std-${options.version}.sflypkg`;
	return { path: join(out, file), file, version: options.version };
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

const publishers = new WeakMap<TestControlPlane, Promise<string>>();

/** 每个控制面一个平台管理员（直接写库，签发凭据的接口在 #490–#492）和他的个人令牌，发布到公共项目用。 */
function publisherToken(cp: TestControlPlane): Promise<string> {
	let token = publishers.get(cp);
	if (token === undefined) {
		token = (async () => {
			const accounts = new TestAccounts(cp.database.url);
			try {
				const admin = await accounts.user("std_publisher", {
					displayName: "标准节点包发布人",
					admin: true,
				});
				return await accounts.personalToken(admin, { name: "发布 sfly-std" });
			} finally {
				await accounts.close();
			}
		})();
		publishers.set(cp, token);
	}
	return token;
}

/**
 * 把节点包归档发布成公共项目里的版本（ADR 0029：平台维护的节点包放在公共项目）：平台管理员的个人令牌
 * `POST /packages?project=public`，和部署者发布 sfly-std 的做法一样（#565）。
 */
export async function publishIntoPublicProject(
	cp: TestControlPlane,
	archive: Uint8Array,
	where: { name: string; version: string },
): Promise<void> {
	const res = await cp.fetch("/packages?project=public", {
		...publishInit(archive),
		headers: {
			"content-type": "application/octet-stream",
			...bearer(await publisherToken(cp)),
		},
	});
	if (res.status !== 201)
		throw new Error(`发布 ${where.name}@${where.version}：${res.status} ${await res.text()}`);
}

/**
 * 升级迁移或手工改库留下的数据：先发布到默认项目，再把它挪进公共项目，不经过「发布到公共项目」时的检查
 * （那里会拒绝和已有版本规范化之后相同的版本）。测包索引对这种数据的防御（同一个版本只列最早发布的那个）用它。
 */
export async function moveIntoPublicProject(
	cp: TestControlPlane,
	archive: Uint8Array,
	where: { name: string; version: string },
): Promise<void> {
	const res = await cp.fetch("/packages", publishInit(archive));
	if (res.status !== 201)
		throw new Error(`发布 ${where.name}@${where.version}：${res.status} ${await res.text()}`);
	const client = new pg.Client({ connectionString: cp.database.url });
	await client.connect();
	try {
		await client.query(
			"update node_packages set project_id = 'public' where name = $1 and version = $2",
			[where.name, where.version],
		);
	} finally {
		await client.end();
	}
}
