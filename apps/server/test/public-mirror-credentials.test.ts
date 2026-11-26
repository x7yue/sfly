// 镜像地址带用户名和密码时，不用登录就能读的地方不把它们写出去（#755）：`/install.sh`（正文和 `--help` 的输出）、
// `/sdk/project-settings`（`sfly init` 写进新节点包的 pyproject.toml）。Agent 握手的 Welcome 照旧原样下发（过渡期没配共享令牌时，
// 连得上 Agent 网关、又知道旧方式登记的名字的连接也拿得到，#494 之后只给带 Agent 凭据的连接：docs/guide/install-agent.md）。
// 没配凭据的地址原样。凭据只写在本文件的常量里，断言逐个检查用户名和密码都没有出现。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readEnvSettings } from "../src/config/env-settings.js";
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

	it('密码里有 " ` < > 空格、制表符、换行、U+00A0、全角空格（启动检查放行、uv 也认）：/install.sh、--help、/sdk/project-settings 里照样没有用户名和密码（审查 #756 的真控制面复现）', async () => {
		for (const pw of [
			'Xy7"k',
			"Xy7`k",
			"Xy7<k",
			"Xy7>k",
			"Xy7 k",
			"Xy7\tk",
			"Xy7\nk",
			"Xy7 k",
			"Xy7　k",
		]) {
			const pypi = `https://deploy:${pw}@pypi.internal/simple`;
			const github = `https://deploy:${pw}@gh.internal/github-release`;
			// 和启动时读环境变量走同一条检查：放行。
			const settings = readEnvSettings({
				SFLY_PYPI_MIRROR: pypi,
				SFLY_GITHUB_RELEASE_MIRROR: github,
			});
			expect(settings.pypiMirror, JSON.stringify(pw)).toBeDefined();
			expect(settings.githubReleaseMirror, JSON.stringify(pw)).toBeDefined();
			const control = await start(
				settings.pypiMirror as string,
				settings.githubReleaseMirror as string,
			);
			const script = await (await control.fetch("/install.sh")).text();
			const project = await (await control.fetch("/sdk/project-settings")).text();
			// 密码在各种写法里都找一遍：原文、JSON 转义、百分号编码、删掉换行制表符之后的。
			const forms = [
				pw,
				JSON.stringify(pw).slice(1, -1),
				encodeURIComponent(pw),
				pw.replace(/[\t\n\r]/g, ""),
			];
			for (const [what, text] of [
				["/install.sh", script],
				["/sdk/project-settings", project],
			] as const) {
				expect(text, `${what}（${JSON.stringify(pw)}）`).not.toContain("deploy");
				for (const form of forms)
					expect(text, `${what}：${JSON.stringify(form)}`).not.toContain(form);
			}
			expect(script).toContain("PYPI_MIRROR='https://pypi.internal/simple'");
			expect(script).toContain("GITHUB_RELEASE_MIRROR='https://gh.internal/github-release'");
			expect(JSON.parse(project)).toMatchObject({
				pypi_mirror: "https://pypi.internal/simple",
				python_install_mirror:
					"https://gh.internal/github-release/astral-sh/python-build-standalone/",
			});
			// Agent 握手拿到的是配置的原值（没有被改过）。
			const agent = await FakeAgent.connect(control.grpcUrl, { name: "agent-odd-password" });
			agents.push(agent);
			expect(agent.welcome).toMatchObject({
				pypiMirror: settings.pypiMirror,
				githubReleaseMirror: settings.githubReleaseMirror,
			});
			await agent.disconnect();
			agents.pop();
			await control.close();
			cp = undefined;
		}
	}, 120_000);

	it("去不干净的镜像地址不公开（当没配），启动时打一条警告，只写是哪个环境变量、不写地址；另一个镜像和 Welcome 不受影响", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			// 解析器不认的写法（密码里有没转义的 \），启动检查本来会拒；这里直接给控制面，看兜底。
			cp = await startTestControlPlane({
				pypiMirror: "https://deploy:Xy7\\k@pypi.internal/simple",
				githubReleaseMirror: GITHUB_WITH,
				logger: true,
			});
			const script = await (await cp.fetch("/install.sh")).text();
			const project = await (await cp.fetch("/sdk/project-settings")).text();
			expect(script).toContain("PYPI_MIRROR=''");
			expect(script).toContain(`GITHUB_RELEASE_MIRROR='${GITHUB_PUBLIC}'`);
			expect(JSON.parse(project)).toMatchObject({ pypi_mirror: null });
			for (const text of [script, project]) {
				expect(text).not.toContain("deploy");
				expectNoCredentials(text, "公开的响应");
			}
			const warnings = warn.mock.calls
				.map((call) => String(call[0]))
				.filter((line) => line.includes("SFLY_PYPI_MIRROR"));
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).not.toContain("deploy");
			expect(warnings[0]).not.toContain("Xy7");
			expect(warnings[0]).not.toContain("pypi.internal");
			expect(
				warn.mock.calls.some((call) => String(call[0]).includes("SFLY_GITHUB_RELEASE_MIRROR")),
			).toBe(false);
			const agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-withheld" });
			agents.push(agent);
			expect(agent.welcome).toMatchObject({
				pypiMirror: "https://deploy:Xy7\\k@pypi.internal/simple",
			});
		} finally {
			warn.mockRestore();
		}
	});

	it("Agent 握手的 Welcome 照旧原样下发带凭据的地址", async () => {
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
