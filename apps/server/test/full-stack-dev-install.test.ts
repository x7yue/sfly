// 全栈：`install.sh --dev`（跳过 systemd）在开发机上装好 uv 和 `sfly` CLI（ADR 0011）。
// 测试机 PATH 上没有 uv：从 GitHub Release 镜像桩安装；`sfly` 从控制面的 sfly 索引安装，
// 依赖（jsonschema 的桩）从控制面配置的 PyPI 镜像桩安装，不访问外网。重新运行即升级到控制面的版本。
// 环境变量覆盖镜像时（单台机器的本地覆盖），uv 和 sfly CLI 的依赖从覆盖的地址安装，覆盖值写进 agent.env。
import { execFile } from "node:child_process";
import { cp as copy, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { arch, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentBinary, repoRoot } from "./support/agent-binary.js";
import { dependencyWheel, type PypiStub, startPypiStub } from "./support/pypi-stub.js";
import { type ReleaseMirror, startReleaseMirror } from "./support/release-mirror.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const run = promisify(execFile);

/** install.sh、uv 安装脚本桩要用的命令（不含 uv），链接到一个单独的 PATH 目录。 */
const TOOLS = [
	"sh",
	"cat",
	"chmod",
	"cp",
	"curl",
	"cut",
	"dirname",
	"flock",
	"gzip",
	"id",
	"mkdir",
	"mktemp",
	"mv",
	"rm",
	"sed",
	"sha256sum",
	"tar",
	"uname",
];

describe("全栈：install.sh --dev", () => {
	let mirror: ReleaseMirror;
	let pypi: PypiStub;
	let dir: string;
	let tools: string;
	let python: string;
	let version: string;
	let newVersion: string;
	const planes: TestControlPlane[] = [];

	beforeAll(async () => {
		const bin = agentBinary();
		dir = await mkdtemp(join(tmpdir(), "sfly-full-dev-install-"));

		// SDK wheel：仓库里的版本，以及只改了版本号的「新版本」。
		const sdkDir = join(dir, "sdk");
		await run("uv", ["build", "--wheel", "--quiet", "--out-dir", sdkDir, "sdk/python"], {
			cwd: repoRoot,
		});
		const sdkCopy = join(dir, "sdk-src");
		for (const part of ["pyproject.toml", "README.md", "src"]) {
			await copy(join(repoRoot, "sdk/python", part), join(sdkCopy, part), { recursive: true });
		}
		const pyproject = await readFile(join(sdkCopy, "pyproject.toml"), "utf8");
		version = /^version = "([^"]+)"/m.exec(pyproject)?.[1] as string;
		newVersion = `${version}.post1`;
		await writeFile(
			join(sdkCopy, "pyproject.toml"),
			pyproject.replace(`version = "${version}"`, `version = "${newVersion}"`),
		);
		const init = join(sdkCopy, "src/sfly/__init__.py");
		await writeFile(
			init,
			(await readFile(init, "utf8")).replace(
				`__version__ = "${version}"`,
				`__version__ = "${newVersion}"`,
			),
		);
		await run("uv", ["build", "--wheel", "--quiet", "--out-dir", sdkDir, sdkCopy]);

		mirror = await startReleaseMirror();
		pypi = await startPypiStub([dependencyWheel("jsonschema", "4.23.0")]);
		for (const v of [version, newVersion]) {
			planes.push(
				await startTestControlPlane({
					version: v,
					agentBinaries: { [arch() === "arm64" ? "aarch64" : "x86_64"]: bin },
					sdkWheelDir: sdkDir,
					githubReleaseMirror: mirror.url,
					pypiMirror: pypi.indexUrl,
				}),
			);
		}

		tools = join(dir, "tools");
		await mkdir(tools);
		const which = async (name: string) =>
			(await run("sh", ["-c", `command -v ${name}`])).stdout.trim();
		for (const name of TOOLS) await symlink(await which(name), join(tools, name));
		// uv tool 的 venv 用测试机上 uv 管理的 Python（不从镜像下载 Python）。
		const pythonVersion = (await readFile(join(repoRoot, ".python-version"), "utf8")).trim();
		python = (await run("uv", ["python", "find", "--no-project", pythonVersion])).stdout.trim();
	}, 600_000);

	afterAll(async () => {
		await Promise.all(planes.map((p) => p.close()));
		await mirror?.close();
		await pypi?.close();
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	const home = () => join(dir, "home");

	async function installDev(
		plane: TestControlPlane,
		options: { home?: string; env?: Record<string, string> } = {},
	) {
		const { stdout } = await run(
			"sh",
			[
				"-c",
				'curl -fsSL "$0/install.sh" | sh -s -- --name dev-agent --no-service --dev',
				plane.httpUrl,
			],
			{
				env: {
					PATH: tools,
					HOME: options.home ?? home(),
					TMPDIR: tmpdir(),
					UV_PYTHON: python,
					...options.env,
				},
			},
		);
		return stdout;
	}

	const sflyVersion = async (h = home()) =>
		(await run(join(h, ".local/bin/sfly"), ["--version"])).stdout.trim();

	it("从镜像装好 uv，从 sfly 索引装好 sfly CLI，版本等于控制面版本", async () => {
		const [plane] = planes as [TestControlPlane];
		const stdout = await installDev(plane);

		expect(mirror.uvInstalls()).toBe(1);
		expect(await sflyVersion()).toBe(`sfly ${version}`);
		// sfly 只从控制面的索引解析，依赖走 PyPI 镜像。
		expect(pypi.requests).toContain("/simple/jsonschema/");
		expect(pypi.requests).not.toContain("/simple/sfly/");
		// ~/.local/bin 不在 PATH 上：提示加进 PATH。
		expect(stdout).toContain(`export PATH='${join(home(), ".local/bin")}':"$PATH"`);
		// agent.env 记录控制面地址（sfly CLI 据此找到控制面）。
		expect(await readFile(join(home(), ".sfly/agent.env"), "utf8")).toContain(
			`SFLY_CONTROL_PLANE_URL=${plane.httpUrl}`,
		);
	}, 300_000);

	it("重新运行时把 sfly 升级到控制面的新版本，uv 已有时不再安装", async () => {
		const [, plane] = planes as [TestControlPlane, TestControlPlane];
		await installDev(plane);
		expect(mirror.uvInstalls()).toBe(1);
		expect(await sflyVersion()).toBe(`sfly ${newVersion}`);
	}, 300_000);

	it("环境变量覆盖镜像：uv 和 sfly CLI 从覆盖的地址安装，覆盖值写进 agent.env，重新运行时保留", async () => {
		const [plane] = planes as [TestControlPlane];
		const localMirror = await startReleaseMirror();
		const localPypi = await startPypiStub([dependencyWheel("jsonschema", "4.23.0")]);
		const otherHome = join(dir, "home-override");
		try {
			const distributedRequests = [mirror.requests.length, pypi.requests.length];
			const pythonMirror = "https://python-mirror.example/astral-sh/python-build-standalone/";
			await installDev(plane, {
				home: otherHome,
				env: {
					SFLY_GITHUB_RELEASE_MIRROR: localMirror.url,
					SFLY_INDEX_URL: localPypi.indexUrl,
					SFLY_PYTHON_INSTALL_MIRROR: pythonMirror,
				},
			});
			expect(localMirror.uvInstalls()).toBe(1);
			expect(localPypi.requests).toContain("/simple/jsonschema/");
			expect(await sflyVersion(otherHome)).toBe(`sfly ${version}`);
			// 没有访问控制面下发的镜像。
			expect([mirror.requests.length, pypi.requests.length]).toEqual(distributedRequests);
			const overrides = [
				`SFLY_INDEX_URL=${localPypi.indexUrl}`,
				`SFLY_GITHUB_RELEASE_MIRROR=${localMirror.url}`,
				`SFLY_PYTHON_INSTALL_MIRROR=${pythonMirror}`,
			];
			const envFile = join(otherHome, ".sfly/agent.env");
			const lines = async () => (await readFile(envFile, "utf8")).split("\n");
			expect(await lines()).toEqual(expect.arrayContaining(overrides));

			// 重新运行时不带环境变量：覆盖值保留，仍然不访问下发的镜像。
			await installDev(plane, { home: otherHome });
			expect(await lines()).toEqual(expect.arrayContaining(overrides));
			expect([mirror.requests.length, pypi.requests.length]).toEqual(distributedRequests);
		} finally {
			await localMirror.close();
			await localPypi.close();
		}
	}, 300_000);
});
