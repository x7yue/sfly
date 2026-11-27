// 镜像地址带用户名和密码时，不用登录就能读的地方不把它们写出去（#755）：`/install.sh`（正文和 `--help` 的输出）、
// `/sdk/project-settings`（`sfly init` 写进新节点包的 pyproject.toml）。Agent 握手的 Welcome 只给带 Agent 凭据的连接原值；
// 以旧方式连接的（共享令牌、没有凭据）拿到的也是去掉了用户名和密码的地址（#494）。
// 没配凭据的地址原样。凭据只写在本文件的常量里，断言逐个检查用户名和密码都没有出现。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
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

	it("Welcome：带 Agent 凭据的连接拿到原值；用共享令牌、不带凭据连接的拿到去掉了用户名和密码的地址（#494）", async () => {
		const control = await startTestControlPlane({
			pypiMirror: PYPI_WITH,
			githubReleaseMirror: GITHUB_WITH,
			agentToken: "shared-token",
		});
		cp = control;
		const withCredential = await FakeAgent.connect(control.grpcUrl, { name: "agent-credential" });
		agents.push(withCredential);
		expect(withCredential.welcome).toMatchObject({
			pypiMirror: PYPI_WITH,
			githubReleaseMirror: GITHUB_WITH,
		});
		const shared = await FakeAgent.connect(control.grpcUrl, {
			name: "agent-shared",
			token: "shared-token",
		});
		agents.push(shared);
		expect(shared.welcome).toMatchObject({
			pypiMirror: PYPI_PUBLIC,
			githubReleaseMirror: GITHUB_PUBLIC,
		});
		expectNoCredentials(JSON.stringify(shared.welcome), "共享令牌连接的 Welcome");
		// 没有凭据的旧方式（没配共享令牌、名字已经登记在默认项目里）：同样拿不到。
		const plain = await startTestControlPlane({
			pypiMirror: PYPI_WITH,
			githubReleaseMirror: GITHUB_WITH,
		});
		try {
			const sql = new pg.Client({ connectionString: plain.database.url });
			await sql.connect();
			await sql.query(
				"insert into agents (name, project_id, info, status, registered_at, last_seen_at) values ('agent-none', 'default', '{}', 'offline', now(), now())",
			);
			await sql.end();
			const none = await FakeAgent.connect(plain.grpcUrl, { name: "agent-none", token: "" });
			expect(none.welcome).toMatchObject({
				pypiMirror: PYPI_PUBLIC,
				githubReleaseMirror: GITHUB_PUBLIC,
			});
			expectNoCredentials(JSON.stringify(none.welcome), "不带凭据连接的 Welcome");
			await none.disconnect();
		} finally {
			await plain.close();
		}
	});

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

	it("`\\` 在用户名位置（WHATWG 读不出、curl 读得出，审查 #756 复审的真控制面复现）：四种写法，/install.sh、--help、/sdk/project-settings 里都没有原文，镜像当没配，--help 写「配了但没公开」，启动警告只写变量名", async () => {
		const samples: Array<{ address: string; fragments: string[] }> = [
			// AD 风格的 域\用户名
			{ address: "https://CORP\\jdoe:Sec7@nexus.corp/simple", fragments: ["CORP", "jdoe", "Sec7"] },
			// 数字加 \ 的密码
			{
				address: "https://deploy:1234\\abc@pypi.internal/simple",
				fragments: ["deploy", "1234", "abc@"],
			},
			// 带 \ 的令牌
			{ address: "https://ghp_tok\\en@gh.internal/github-release", fragments: ["ghp_tok", "en@"] },
			// \ 在用户名之前
			{
				address: "https://mirror.corp\\u:Sec7@evil.example/simple",
				fragments: ["mirror.corp", "Sec7", "evil.example"],
			},
		];
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			for (const { address, fragments } of samples) {
				// 启动检查放行它（这样的地址是真的可以配出来的）。
				const settings = readEnvSettings({
					SFLY_PYPI_MIRROR: address,
					SFLY_GITHUB_RELEASE_MIRROR: address,
				});
				expect(settings.pypiMirror, address).toBe(address);
				warn.mockClear();
				const control = await startTestControlPlane({
					pypiMirror: settings.pypiMirror,
					githubReleaseMirror: settings.githubReleaseMirror,
					logger: true,
				});
				cp = control;
				const script = await (await control.fetch("/install.sh")).text();
				const project = await (await control.fetch("/sdk/project-settings")).text();
				const { stdout } = await run("sh", [
					"-c",
					'curl -fsSL "$0/install.sh" | sh -s -- --help',
					control.httpUrl,
				]);
				for (const [what, text] of [
					["/install.sh", script],
					["--help", stdout],
					["/sdk/project-settings", project],
				] as const) {
					expect(text, `${what}：${address}`).not.toContain(address);
					for (const fragment of fragments) {
						expect(text, `${what}（${address}）里有 ${fragment}`).not.toContain(fragment);
					}
				}
				// 两个镜像都当没配，--help 写明是配了但没公开（不写「未配置」）。
				expect(script).toContain("PYPI_MIRROR=''");
				expect(script).toContain("GITHUB_RELEASE_MIRROR=''");
				expect(script).toContain("PYPI_MIRROR_WITHHELD='1'");
				expect(script).toContain("GITHUB_RELEASE_MIRROR_WITHHELD='1'");
				expect(stdout).toContain("控制面配置的 PyPI 镜像：配了，但地址带用户名和密码，没有公开");
				expect(stdout).toContain(
					"控制面配置的 GitHub Release 镜像：配了，但地址带用户名和密码，没有公开",
				);
				expect(stdout).not.toContain("未配置");
				expect(JSON.parse(project)).toMatchObject({
					pypi_mirror: null,
					python_install_mirror: null,
				});
				// 启动警告：每个镜像一条，只写环境变量名。
				const lines = warn.mock.calls.map((call) => String(call[0]));
				expect(lines.filter((line) => line.includes("SFLY_PYPI_MIRROR"))).toHaveLength(1);
				expect(lines.filter((line) => line.includes("SFLY_GITHUB_RELEASE_MIRROR"))).toHaveLength(1);
				for (const line of lines) {
					for (const fragment of fragments) expect(line).not.toContain(fragment);
				}
				// Agent 握手拿到的是配置的原值。
				const agent = await FakeAgent.connect(control.grpcUrl, { name: "agent-backslash" });
				expect(agent.welcome).toMatchObject({ pypiMirror: address, githubReleaseMirror: address });
				await agent.disconnect();
				await control.close();
				cp = undefined;
			}
		} finally {
			warn.mockRestore();
		}
	}, 120_000);

	it("没配的镜像 --help 照旧写「未配置」，公开了的写地址", async () => {
		const control = await start("", GITHUB_WITH);
		const { stdout } = await run("sh", [
			"-c",
			'curl -fsSL "$0/install.sh" | sh -s -- --help',
			control.httpUrl,
		]);
		expect(stdout).toContain("控制面配置的 PyPI 镜像：未配置");
		expect(stdout).toContain(`控制面配置的 GitHub Release 镜像：${GITHUB_PUBLIC}`);
	});

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
