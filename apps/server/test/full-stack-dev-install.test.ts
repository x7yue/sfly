// 全栈：`install.sh --dev`（跳过 systemd）在开发机上装好 uv 和 `sfly` CLI（ADR 0011）。
// 测试机 PATH 上没有 uv：从 GitHub Release 镜像桩安装；`sfly` 从控制面的 sfly 索引安装，
// 依赖（jsonschema 的桩）从控制面配置的 PyPI 镜像桩安装，不访问外网。重新运行即升级到控制面的版本。
// 环境变量覆盖镜像时（单台机器的本地覆盖），uv 和 sfly CLI 的依赖从覆盖的地址安装，覆盖值写进 agent.env。
import { execFile } from "node:child_process";
import { cp as copy, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { arch, hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { agentBinary, repoRoot } from "./support/agent-binary.js";
import { TestAccounts } from "./support/credentials.js";
import { describeWithAgent } from "./support/describe-with-agent.js";
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

describeWithAgent("全栈：install.sh --dev", () => {
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
		options: { home?: string; env?: Record<string, string>; args?: string[] } = {},
	) {
		const { stdout } = await run(
			"sh",
			[
				"-c",
				'curl -fsSL "$0/install.sh" | sh -s -- "$@"',
				plane.httpUrl,
				...(options.args ?? ["--name", "dev-agent", "--no-service", "--dev"]),
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
		// 下载安装脚本和安装脚本里下载 uv 都带 sfly 的 User-Agent（镜像站会封禁 curl 的默认 User-Agent）。
		expect(mirror.uvUserAgents()).toEqual([`sfly-agent/${version}`, `sfly-agent/${version}`]);
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

	it("环境变量覆盖镜像和 User-Agent：uv 和 sfly CLI 从覆盖的地址安装，覆盖值写进 agent.env，重新运行时保留", async () => {
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
					SFLY_USER_AGENT: "acme-lab-sfly/1.0",
				},
			});
			expect(localMirror.uvInstalls()).toBe(1);
			expect(localMirror.uvUserAgents()).toEqual(["acme-lab-sfly/1.0", "acme-lab-sfly/1.0"]);
			expect(localPypi.requests).toContain("/simple/jsonschema/");
			expect(await sflyVersion(otherHome)).toBe(`sfly ${version}`);
			// 没有访问控制面下发的镜像。
			expect([mirror.requests.length, pypi.requests.length]).toEqual(distributedRequests);
			const overrides = [
				`SFLY_INDEX_URL=${localPypi.indexUrl}`,
				`SFLY_GITHUB_RELEASE_MIRROR=${localMirror.url}`,
				`SFLY_PYTHON_INSTALL_MIRROR=${pythonMirror}`,
				"SFLY_USER_AGENT=acme-lab-sfly/1.0",
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

	/** 本机的主机名规整成开发 Agent 名字里「主机」那一段（和 `sfly agent register-dev` 的默认一样）。 */
	const hostSegment = () =>
		hostname()
			.split(".")[0]
			?.toLowerCase()
			.replace(/[^a-z0-9-]/g, "-")
			.slice(0, 32)
			.replace(/^-+|-+$/g, "") as string;

	// 不给 --name：装好真的 sfly CLI 之后，用 SFLY_API_TOKEN 向真的控制面注册自己的开发 Agent（#492）。
	it("不给 --name：注册自己的开发 Agent，名字是 dev-<登录名>-<主机>，凭据写进 agent.env；重新运行沿用，不再注册", async () => {
		const [plane] = planes as [TestControlPlane];
		const accounts = new TestAccounts(plane.database.url);
		try {
			const userId = await accounts.user("devowner", { displayName: "开发者" });
			await accounts.member("default", userId, "editor");
			const token = await accounts.personalToken(userId, { name: "装开发机" });
			const registerHome = join(dir, "home-register");
			const args = ["--no-service", "--dev"];

			const stdout = await installDev(plane, {
				home: registerHome,
				args,
				env: { SFLY_API_TOKEN: token },
			});
			const name = `dev-devowner-${hostSegment()}`;
			const envFile = join(registerHome, ".sfly/agent.env");
			const text = await readFile(envFile, "utf8");
			expect(text).toContain(`SFLY_AGENT_NAME=${name}\n`);
			const credential = /^SFLY_TOKEN=(sfly_agt_[0-9a-f]{48})$/m.exec(text)?.[1] as string;
			expect(credential, text).toBeDefined();
			// 凭据只在 agent.env 里：没有打印，也不在个人令牌的命令行输出里。
			expect(stdout).not.toContain(credential);
			expect(stdout).toContain(`已注册开发 Agent ${name}`);
			// 控制面上这个名字只有一个有效的凭据（库里直接数）。
			const db = new pg.Client({ connectionString: plane.database.url });
			await db.connect();
			const count = async () =>
				Number(
					(
						await db.query(
							"select count(*)::int as n from agent_credentials where agent_name = $1 and revoked_at is null",
							[name],
						)
					).rows[0]?.n,
				);
			expect(await count()).toBe(1);

			// 重新运行（没有令牌也行）：沿用 agent.env 里的名字和凭据，不再注册。
			const again = await installDev(plane, { home: registerHome, args });
			expect(again).toContain(`沿用`);
			expect(await readFile(envFile, "utf8")).toContain(`SFLY_TOKEN=${credential}\n`);
			expect(await count()).toBe(1);
			await db.end();
		} finally {
			await accounts.close();
		}
	}, 300_000);
});
