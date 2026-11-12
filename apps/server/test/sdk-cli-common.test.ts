// sfly 命令行访问控制面的公共部分（地址、昵称、x-sfly-client、版本告警、错误格式），
// 以真实的 sfly 进程加测试控制面验证；用 `scenario list` 作为载体。
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RecordingProxy, startRecordingProxy } from "./support/recording-proxy.js";
import { sfly } from "./support/sfly-cli.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const CLIENT = "x-sfly-client";
const NICKNAME = "x-sfly-nickname";

describe("sfly 命令行的公共部分 → 控制面", () => {
	let cp: TestControlPlane;
	let cliVersion: string;
	const proxies: RecordingProxy[] = [];
	const dirs: string[] = [];

	const proxy = async (): Promise<RecordingProxy> => {
		const p = await startRecordingProxy(cp.httpUrl);
		proxies.push(p);
		return p;
	};

	beforeAll(async () => {
		const reported = await sfly(["--version"]);
		cliVersion = reported.stdout.trim().replace(/^sfly /, "");
		cp = await startTestControlPlane({ version: cliVersion });
	}, 120_000);

	afterAll(async () => {
		await Promise.all(proxies.map((p) => p.close()));
		await cp?.close();
		await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
	});

	it("控制面地址按 --server、SFLY_SERVER、agent.env 的顺序取值", async () => {
		const [viaFlag, viaEnv, viaFile] = [await proxy(), await proxy(), await proxy()] as const;
		const home = await mkdtemp(join(tmpdir(), "sfly-home-"));
		dirs.push(home);
		await writeFile(join(home, "agent.env"), `SFLY_CONTROL_PLANE_URL=${viaFile.url}\n`);
		const hits = () => [viaFlag, viaEnv, viaFile].map((p) => p.requests.length > 0);

		const all = await sfly(["scenario", "list", "--server", viaFlag.url], {
			env: { SFLY_SERVER: viaEnv.url, SFLY_HOME: home },
		});
		expect(all.code, all.stderr).toBe(0);
		expect(hits()).toEqual([true, false, false]);

		viaFlag.requests.length = 0;
		const envAndFile = await sfly(["scenario", "list"], {
			env: { SFLY_SERVER: viaEnv.url, SFLY_HOME: home },
		});
		expect(envAndFile.code, envAndFile.stderr).toBe(0);
		expect(hits()).toEqual([false, true, false]);

		viaEnv.requests.length = 0;
		const fileOnly = await sfly(["scenario", "list"], { env: { SFLY_HOME: home } });
		expect(fileOnly.code, fileOnly.stderr).toBe(0);
		expect(hits()).toEqual([false, false, true]);
	});

	it("昵称按 --nickname、SFLY_NICKNAME、系统用户名的顺序取值，请求头按 URL 编码", async () => {
		const seen = await proxy();
		const nicknames = async (args: string[], env: Record<string, string>) => {
			seen.requests.length = 0;
			const result = await sfly(["scenario", "list", "--server", seen.url, ...args], { env });
			expect(result.code, result.stderr).toBe(0);
			return seen.requests.map((r) => r.headers[NICKNAME]);
		};
		const login = { LOGNAME: "login-user", USER: "login-user" };

		expect(
			await nicknames(["--nickname", "小明"], { SFLY_NICKNAME: "from-env", ...login }),
		).toEqual([encodeURIComponent("小明")]);
		expect(await nicknames([], { SFLY_NICKNAME: "from-env", ...login })).toEqual(["from-env"]);
		expect(await nicknames([], login)).toEqual(["login-user"]);
	});

	it.each([
		["不在 AI 编程助手里时只有命令行版本", {}, ""],
		["CLAUDECODE 表示 claude-code", { CLAUDECODE: "1" }, " agent/claude-code"],
		["CODEX_ 开头的环境变量表示 codex", { CODEX_SANDBOX: "seatbelt" }, " agent/codex"],
		["AI_AGENT 有值时用它作名称", { AI_AGENT: "my-bot", CLAUDECODE: "1" }, " agent/my-bot"],
	])("x-sfly-client：%s", async (_name, env, suffix) => {
		const seen = await proxy();
		const result = await sfly(["scenario", "list", "--server", seen.url], { env });
		expect(result.code, result.stderr).toBe(0);
		expect(seen.requests.length).toBeGreaterThan(0);
		for (const request of seen.requests) {
			expect(request.headers[CLIENT]).toBe(`sfly-cli/${cliVersion}${suffix}`);
		}
	});

	it("检测到 AI 编程助手时输出格式不变", async () => {
		const plain = await sfly(["scenario", "list", "--server", cp.httpUrl]);
		const inAssistant = await sfly(["scenario", "list", "--server", cp.httpUrl], {
			env: { CLAUDECODE: "1" },
		});
		expect(inAssistant.stdout).toBe(plain.stdout);
		expect(inAssistant.stderr).toBe(plain.stderr);
	});

	it("控制面版本和命令行不一致时在 stderr 告警一次，命令照常完成", async () => {
		const newer = await startTestControlPlane({ version: "9.9.9" });
		try {
			const text = await sfly(["scenario", "list", "--server", newer.httpUrl]);
			expect(text.code, text.stderr).toBe(0);
			expect(text.stdout.trim()).toBe("还没有场景");
			const warnings = text.stderr.trim().split("\n");
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain(`命令行（${cliVersion}）`);
			expect(warnings[0]).toContain("控制面（9.9.9）");
			expect(warnings[0]).toContain("install.sh --dev");
			expect(warnings[0]).toContain('uv add --dev "sfly[cli]==9.9.9"');

			const json = await sfly(["scenario", "list", "--json", "--server", newer.httpUrl]);
			expect(json.code, json.stderr).toBe(0);
			expect(JSON.parse(json.stdout)).toEqual([]);
			expect(json.stderr).toContain("9.9.9");

			// 找不到场景（多次请求、最后出错）时也只告警一次。
			const failed = await sfly(["scenario", "show", "没有这个场景", "--server", newer.httpUrl]);
			expect(failed.code).toBe(2);
			expect(failed.stderr.match(/警告：/g)).toHaveLength(1);
		} finally {
			await newer.close();
		}
	});

	it("版本一致时没有告警", async () => {
		const result = await sfly(["scenario", "list", "--server", cp.httpUrl]);
		expect(result.code, result.stderr).toBe(0);
		expect(result.stderr).toBe("");
	});

	describe("错误：写明原因和下一步命令，退出码 2", () => {
		let stub: Server;
		let stubUrl: string;
		beforeAll(async () => {
			stub = createServer((req, res) => {
				if (req.url?.startsWith("/boom")) {
					res.writeHead(502, { "content-type": "text/html" }).end("<html>Bad Gateway</html>");
					return;
				}
				res
					.writeHead(500, { "content-type": "application/json" })
					.end(
						JSON.stringify({ error: { code: "internal_error", message: "internal server error" } }),
					);
			});
			await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
			stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
		});
		afterAll(() => {
			stub.closeAllConnections();
			stub.close();
		});

		it("连不上控制面", async () => {
			const unreachable = "http://127.0.0.1:1";
			const text = await sfly(["scenario", "list", "--server", unreachable]);
			expect(text.code).toBe(2);
			expect(text.stdout).toBe("");
			const lines = text.stderr.trim().split("\n");
			expect(lines[0]).toMatch(/^错误：无法连接控制面 http:\/\/127\.0\.0\.1:1：/);
			expect(text.stderr).toContain("--server、SFLY_SERVER");
			expect(lines.at(-1)).toBe(`下一步：curl ${unreachable}/health`);

			const json = await sfly(["scenario", "list", "--json", "--server", unreachable]);
			expect(json.code).toBe(2);
			expect(json.stdout).toBe("");
			const { error } = JSON.parse(json.stderr) as {
				error: { code: string; message: string; next: string };
			};
			expect(error.code).toBe("unreachable");
			expect(error.message).toContain("无法连接控制面");
			expect(error.next).toBe(`curl ${unreachable}/health`);
		});

		it("控制面返回错误：沿用控制面的错误码和原因", async () => {
			const text = await sfly(["scenario", "list", "--server", cp.httpUrl, "--agent", ""]);
			expect(text.code).toBe(2);
			expect(text.stdout).toBe("");
			expect(text.stderr).toMatch(/^错误：.+/);

			const json = await sfly([
				"scenario",
				"list",
				"--json",
				"--server",
				cp.httpUrl,
				"--agent",
				"",
			]);
			expect(json.code).toBe(2);
			const { error } = JSON.parse(json.stderr) as {
				error: { code: string; message: string; next: string | null };
			};
			expect(error.code).toBe("invalid_request");
			expect(error.message).not.toBe("");
			expect(error.next).toBeNull();
		});

		it("控制面内部出错：下一步是检查控制面是否正常", async () => {
			const json = await sfly(["scenario", "list", "--json", "--server", stubUrl]);
			expect(json.code).toBe(2);
			expect(JSON.parse(json.stderr)).toEqual({
				error: {
					code: "internal_error",
					message: "internal server error",
					next: `curl ${stubUrl}/health`,
				},
			});
		});

		it("响应不是控制面的错误格式时按 HTTP 状态码报告", async () => {
			const json = await sfly(["scenario", "list", "--json", "--server", `${stubUrl}/boom`]);
			expect(json.code).toBe(2);
			const { error } = JSON.parse(json.stderr) as { error: { code: string; message: string } };
			expect(error.code).toBe("http_502");
			expect(error.message).toContain("HTTP 502");
		});
	});
});
