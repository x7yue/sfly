// 镜像地址带用户名和密码时，不用登录就能读的地方不把它们写出去（#755）：`/install.sh`（正文和 `--help` 的输出）、
// `/sdk/project-settings`（`sfly init` 写进新节点包的 pyproject.toml）。Agent 握手的 Welcome 是经过认证的连接，照旧原样下发。
// 没配凭据的地址原样。凭据只写在本文件的常量里，断言逐个检查用户名和密码都没有出现。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAgent } from "./support/fake-agent.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const run = promisify(execFile);

const PYPI_USER = "idxuser";
const PYPI_PASSWORD = "idxpass-7a2d";
const GITHUB_USER = "ghuser";
const GITHUB_PASSWORD = "ghpass-1c3e";
const SECRETS = [PYPI_USER, PYPI_PASSWORD, GITHUB_USER, GITHUB_PASSWORD];
const PYPI_WITH = `https://${PYPI_USER}:${PYPI_PASSWORD}@pypi.internal:8443/simple`;
const GITHUB_WITH = `https://${GITHUB_USER}:${GITHUB_PASSWORD}@gh.internal/github-release/`;
const PYPI_PUBLIC = "https://pypi.internal:8443/simple";
const GITHUB_PUBLIC = "https://gh.internal/github-release/";

function expectNoCredentials(text: string, what: string): void {
	for (const secret of SECRETS) expect(text, `${what}：${secret}`).not.toContain(secret);
}

describe("公开的地方不带镜像地址里的用户名和密码", () => {
	let cp: TestControlPlane | undefined;
	const agents: FakeAgent[] = [];
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp?.close();
		cp = undefined;
	});
	const start = async (pypiMirror: string, githubReleaseMirror: string) => {
		cp = await startTestControlPlane({ pypiMirror, githubReleaseMirror });
		return cp;
	};

	it("不登录下载的 /install.sh：正文里的两个镜像地址去掉了用户名和密码，主机、端口、路径留着", async () => {
		const control = await start(PYPI_WITH, GITHUB_WITH);
		const res = await control.fetch("/install.sh"); // 没带任何凭据
		expect(res.status).toBe(200);
		const body = await res.text();
		expectNoCredentials(body, "/install.sh 正文");
		expect(body).toContain(`PYPI_MIRROR='${PYPI_PUBLIC}'`);
		expect(body).toContain(`GITHUB_RELEASE_MIRROR='${GITHUB_PUBLIC}'`);
	});

	it("--help 的输出：没有用户名和密码，写着控制面配置的镜像（去掉凭据的）和 ~/.netrc", async () => {
		const control = await start(PYPI_WITH, GITHUB_WITH);
		const { stdout, stderr } = await run("sh", [
			"-c",
			'curl -fsSL "$0/install.sh" | sh -s -- --help',
			control.httpUrl,
		]);
		expectNoCredentials(stdout, "--help 的标准输出");
		expectNoCredentials(stderr, "--help 的标准错误");
		expect(stdout).toContain(`控制面配置的 PyPI 镜像：${PYPI_PUBLIC}`);
		expect(stdout).toContain(`控制面配置的 GitHub Release 镜像：${GITHUB_PUBLIC}`);
		expect(stdout).toContain("~/.netrc");
	});

	it("/sdk/project-settings（sfly init 写进新节点包 pyproject.toml 的）：PyPI 镜像和 Python 下载镜像都去掉了用户名和密码", async () => {
		const control = await start(PYPI_WITH, GITHUB_WITH);
		const res = await control.fetch("/sdk/project-settings");
		expect(res.status).toBe(200);
		const text = await res.text();
		expectNoCredentials(text, "/sdk/project-settings");
		expect(JSON.parse(text)).toMatchObject({
			pypi_mirror: PYPI_PUBLIC,
			python_install_mirror:
				"https://gh.internal/github-release/astral-sh/python-build-standalone/",
		});
	});

	it("别的不用登录的接口也没有：把每个公开的路径读一遍，响应里都没有用户名和密码", async () => {
		const control = await start(PYPI_WITH, GITHUB_WITH);
		for (const path of [
			"/health",
			"/agent/binaries",
			"/client",
			"/docs",
			"/llms.txt",
			"/docs/install-agent.md",
			"/sdk/python",
			"/simple/",
			"/simple/sfly/",
			"/simple/sfly-std/",
			"/install.sh",
			"/sdk/project-settings",
		]) {
			const res = await control.fetch(path);
			const text = await res.text();
			expectNoCredentials(text, path);
			expectNoCredentials(JSON.stringify([...res.headers]), `${path} 的响应头`);
		}
	});

	it("Agent 握手的 Welcome（经过认证的连接）照旧原样下发带凭据的地址", async () => {
		const control = await start(PYPI_WITH, GITHUB_WITH);
		const agent = await FakeAgent.connect(control.grpcUrl, { name: "agent-credentialed-mirrors" });
		agents.push(agent);
		expect(agent.welcome).toMatchObject({
			pypiMirror: PYPI_WITH,
			githubReleaseMirror: GITHUB_WITH,
		});
	});

	it("没配凭据的地址原样（含 file:// 和绝对路径）；只有一个镜像带凭据时另一个不动", async () => {
		const plain = await start(
			"https://mirrors.ustc.edu.cn/pypi/simple",
			"file:///mnt/mirror/github-release",
		);
		let body = await (await plain.fetch("/install.sh")).text();
		expect(body).toContain("PYPI_MIRROR='https://mirrors.ustc.edu.cn/pypi/simple'");
		expect(body).toContain("GITHUB_RELEASE_MIRROR='file:///mnt/mirror/github-release'");
		await plain.close();

		const local = await start("/mnt/mirror/pypi/simple", "");
		body = await (await local.fetch("/install.sh")).text();
		expect(body).toContain("PYPI_MIRROR='/mnt/mirror/pypi/simple'");
		expect(body).toContain("GITHUB_RELEASE_MIRROR=''");
		await local.close();

		const mixed = await start("https://mirrors.ustc.edu.cn/pypi/simple", GITHUB_WITH);
		body = await (await mixed.fetch("/install.sh")).text();
		expect(body).toContain("PYPI_MIRROR='https://mirrors.ustc.edu.cn/pypi/simple'");
		expect(body).toContain(`GITHUB_RELEASE_MIRROR='${GITHUB_PUBLIC}'`);
		expectNoCredentials(body, "/install.sh 正文");
	});
});
