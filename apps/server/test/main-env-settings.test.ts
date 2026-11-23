// 控制面读的数值类（#577）和字符串类（#619）环境变量在启动时就检查：用真实的 `src/main.ts`（和 `pnpm start` 一样用 tsx 运行）试。
// 数据库地址故意填一个连不上的：过了检查的值会走到连数据库那一步才失败，没过的在那之前就退出（退出码 1），
// 信息写着环境变量的名字、填的原文和范围，几个变量都不合法时一次报完。逐个变量的取值范围在 env-settings.test.ts，
// 这里守的是 `main.ts` 的接线：每个变量都经过检查，把任何一个改回原来的读法（`positive()`、`Number(...)`），对应那一行就红。
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "./support/test-database.js";

const run = promisify(execFile);
const serverDir = join(import.meta.dirname, "..");

async function startMain(settings: Record<string, string>) {
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "",
		// 连不上的数据库：1 号端口没有人监听，立刻 ECONNREFUSED。
		DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:1/none",
		SFLY_HTTP_PORT: "0",
		SFLY_GRPC_PORT: "0",
		SFLY_DATA_DIR: join(serverDir, "..", "..", "node_modules", ".cache", "main-env-test"),
		...settings,
	};
	try {
		await run(process.execPath, ["--import", "tsx", "src/main.ts"], {
			cwd: serverDir,
			env,
			timeout: 60_000,
		});
		return { code: 0, output: "" };
	} catch (error) {
		const failed = error as { code?: number | string; stderr?: string; stdout?: string };
		return { code: failed.code, output: `${failed.stderr ?? ""}${failed.stdout ?? ""}` };
	}
}

/** 每个数值类变量一个不合法的值，和说明里该有的范围。 */
const BAD: Array<[name: string, value: string, range: string]> = [
	["SFLY_RETENTION_DAYS", "Infinity", "大于 0、不超过 36500 的数（天）"],
	["SFLY_RETENTION_DAYS", "100000000", "大于 0、不超过 36500 的数（天）"],
	["SFLY_METRIC_RETENTION_DAYS", "2500000", "大于 0、不超过 36500 的数（天）"],
	["SFLY_METRIC_RETENTION_DAYS", "-1", "大于 0、不超过 36500 的数（天）"],
	["SFLY_LOG_LIMIT_MB", "Infinity", "之间的整数"],
	["SFLY_LOG_LIMIT_MB", "1e300", "之间的整数"],
	["SFLY_METRIC_LIMIT_MB", "Infinity", "之间的整数"],
	["SFLY_METRIC_LIMIT_MB", "abc", "之间的整数"],
	["SFLY_LOGIN_IDLE_HOURS", "Infinity", "2 分钟到 876000 小时之间的数"],
	["SFLY_LOGIN_IDLE_HOURS", "1e9", "2 分钟到 876000 小时之间的数"],
	["SFLY_LOGIN_IDLE_HOURS", "0.01", "下限是登录续期间隔（60 秒）的两倍"],
	["SFLY_LOG_LIMIT_MB", "10MB", "单位是 MB"],
	["SFLY_HTTP_PORT", "+8080", "只认不带符号的十进制整数"],
	["SFLY_HTTP_PORT", "70000", "端口必须是 0 到 65535 之间的整数"],
	["SFLY_GRPC_PORT", "abc", "端口必须是 0 到 65535 之间的整数"],
];

describe("main.ts 读数值类环境变量", () => {
	it.each(BAD)(
		"%s=%s：启动时就报错退出，信息写着变量名、填的原文和范围",
		async (name, value, range) => {
			const result = await startMain({ [name]: value });

			expect(result.code, result.output).toBe(1);
			expect(result.output).toContain(`${name} 不合法`);
			expect(result.output).toContain(`"${value}"`);
			expect(result.output).toContain(range);
			// 在这之前就退出：没有走到连数据库那一步。
			expect(result.output).not.toContain("ECONNREFUSED");
		},
		90_000,
	);

	it("几个变量同时不合法：一次报完，每个一条，合法的那个不在里面", async () => {
		const result = await startMain({
			SFLY_RETENTION_DAYS: "Infinity",
			SFLY_METRIC_RETENTION_DAYS: "30",
			SFLY_LOG_LIMIT_MB: "abc",
			SFLY_HTTP_PORT: "70000",
		});

		expect(result.code, result.output).toBe(1);
		expect(result.output).toContain("3 个环境变量不合法");
		for (const name of ["SFLY_RETENTION_DAYS", "SFLY_LOG_LIMIT_MB", "SFLY_HTTP_PORT"]) {
			expect(result.output, name).toContain(`${name} 不合法`);
		}
		expect(result.output).not.toContain("SFLY_METRIC_RETENTION_DAYS");
	}, 90_000);

	it("全部填上限以内的最大值（端口 0）：通过检查，之后才在连数据库那一步失败", async () => {
		const result = await startMain({
			SFLY_RETENTION_DAYS: "36500",
			SFLY_METRIC_RETENTION_DAYS: "36500",
			SFLY_LOG_LIMIT_MB: "8589934591",
			SFLY_ARTIFACT_LIMIT_MB: "8589934591",
			SFLY_METRIC_LIMIT_MB: "8589934591",
			SFLY_LOGIN_IDLE_HOURS: "876000",
		});

		expect(result.code, result.output).not.toBe(0);
		expect(result.output).not.toContain("不合法");
		expect(result.output).not.toContain("没有启动");
	}, 90_000);
});

/** 会出现在密码、地址里的凭据位置的记号：输出里不能有它（哪怕是一部分）。 */
const SECRET = "Hunter2-secret-9f3a";

/** 每个字符串类变量一个不合法的值：说明里要有变量名、填的值（带凭据的不回显）和要求里的一句话。 */
const BAD_STRINGS: Array<[name: string, value: string, shown: string, requirement: string]> = [
	["SFLY_TRUST_PROXY", "banana", "banana", "代理的层数"],
	["SFLY_CORS_ORIGINS", "dash.example.com", '"dash.example.com"', "协议://主机"],
	["SFLY_DEV_ORIGINS", "localhost:3000x y", '"localhost:3000x y"', "协议://主机"],
	["SFLY_ADMIN_LOGIN", "root", "", "要一起设置"],
	["SFLY_ADMIN_PASSWORD", SECRET, "", "要一起设置"],
	["SFLY_PUBLIC_URL", "sfly.internal:8080", '"sfly.internal:8080"', "http 或 https"],
	["SFLY_PUBLIC_URL", "http//sfly:8080", '"http//sfly:8080"', "http 或 https"],
	["SFLY_PUBLIC_URL", `https://admin:${SECRET}@sfly.example.com`, "没有回显", "http 或 https"],
	["SFLY_PUBLIC_GRPC_URL", "grpc.example.com:50051", '"grpc.example.com:50051"', "http 或 https"],
	["DATABASE_URL", `postgres//sfly:${SECRET}@db/sfly`, "没有回显", "postgres://"],
	["SFLY_PYPI_MIRROR", "mirror.internal", '"mirror.internal"', "http 或 https"],
	[
		"SFLY_GITHUB_RELEASE_MIRROR",
		"ftp://mirror.internal",
		'"ftp://mirror.internal"',
		"http 或 https",
	],
];

describe("main.ts 读字符串类环境变量", () => {
	it.each(BAD_STRINGS)(
		"%s=%s：启动时就报错退出，说明里有变量名和要求，没有堆栈，没有密码",
		async (name, value, shown, requirement) => {
			const result = await startMain({ [name]: value });

			expect(result.code, result.output).toBe(1);
			expect(result.output).toContain("控制面没有启动");
			expect(result.output).toContain(name);
			expect(result.output).toContain(shown);
			expect(result.output).toContain(requirement);
			// 不是未捕获的错误：没有堆栈，也没有走到连数据库那一步。
			expect(result.output).not.toMatch(/\n\s+at /);
			expect(result.output).not.toContain("ECONNREFUSED");
			expect(result.output).not.toContain(SECRET);
		},
		90_000,
	);

	it("字符串类和数值类的几个变量同时不合法：一次报完，每个一条；不出现密码", async () => {
		const result = await startMain({
			SFLY_RETENTION_DAYS: "Infinity",
			SFLY_TRUST_PROXY: "banana",
			SFLY_ADMIN_PASSWORD: SECRET,
			SFLY_PUBLIC_URL: "sfly.internal:8080",
			DATABASE_URL: `postgres//sfly:${SECRET}@db/sfly`,
			SFLY_METRIC_RETENTION_DAYS: "30",
		});

		expect(result.code, result.output).toBe(1);
		expect(result.output).toContain("5 个环境变量不合法");
		for (const name of [
			"SFLY_RETENTION_DAYS",
			"SFLY_TRUST_PROXY",
			"SFLY_ADMIN_LOGIN",
			"SFLY_PUBLIC_URL",
			"DATABASE_URL",
		]) {
			expect(result.output, name).toContain(name);
		}
		expect(result.output).not.toContain("SFLY_METRIC_RETENTION_DAYS");
		expect(result.output).not.toContain(SECRET);
		expect(result.output).not.toMatch(/\n\s+at /);
	}, 90_000);

	it("全部写合规矩（地址、名单、代理、镜像）：通过检查，之后才在连数据库那一步失败", async () => {
		const result = await startMain({
			SFLY_TRUST_PROXY: "127.0.0.1,10.0.0.0/8",
			SFLY_CORS_ORIGINS: "https://dash.example.com,http://localhost:5173",
			SFLY_DEV_ORIGINS: "http://localhost:3000",
			SFLY_ADMIN_LOGIN: "root",
			SFLY_ADMIN_PASSWORD: "admin-password-1",
			SFLY_PUBLIC_URL: "https://sfly.example.com",
			SFLY_PUBLIC_GRPC_URL: "http://sfly.example.com:50051",
			SFLY_PYPI_MIRROR: "https://mirrors.ustc.edu.cn/pypi/simple",
			SFLY_GITHUB_RELEASE_MIRROR: `https://u:${SECRET}@mirror.internal/github-release`,
		});

		expect(result.code, result.output).not.toBe(0);
		expect(result.output).not.toContain("不合法");
		expect(result.output).not.toContain("没有启动");
	}, 90_000);
});

/** 起一个真的控制面进程（连真的数据库）：返回它的 HTTP 地址、到目前为止的输出和停止它的办法。 */
async function spawnControlPlane(settings: Record<string, string>) {
	const database = await createTestDatabase("sfly_main_env");
	const dataDir = await mkdtemp(join(tmpdir(), "sfly-main-env-"));
	const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
		cwd: serverDir,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: process.env.HOME ?? "",
			DATABASE_URL: database.url,
			SFLY_DATA_DIR: dataDir,
			SFLY_HTTP_HOST: "127.0.0.1",
			SFLY_GRPC_HOST: "127.0.0.1",
			SFLY_HTTP_PORT: "0",
			SFLY_GRPC_PORT: "0",
			...settings,
		},
	});
	let output = "";
	child.stdout.on("data", (chunk) => {
		output += String(chunk);
	});
	child.stderr.on("data", (chunk) => {
		output += String(chunk);
	});
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	const stop = async () => {
		child.kill("SIGTERM");
		await exited;
		await database.drop();
		await rm(dataDir, { recursive: true, force: true });
	};
	try {
		// 控制面启动后打印「http <地址>」。
		const httpUrl = await new Promise<string>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`控制面没有在 60 秒内启动：${output}`)),
				60_000,
			);
			const check = setInterval(() => {
				const found = /http (http:\/\/[^,\s]+)/.exec(output);
				if (found?.[1]) {
					clearTimeout(timer);
					clearInterval(check);
					resolve(found[1]);
				}
			}, 100);
			child.once("exit", () => {
				clearTimeout(timer);
				clearInterval(check);
				reject(new Error(`控制面退出了：${output}`));
			});
		});
		return { httpUrl, output: () => output, stop };
	} catch (error) {
		await stop();
		throw error;
	}
}

/** 一个现在空闲的端口（取到之后立刻放掉）。 */
async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as { port: number };
	await new Promise((resolve) => server.close(resolve));
	return port;
}

describe("main.ts：合法的值真的传给了控制面", () => {
	it("SFLY_LOGIN_IDLE_HOURS=2：控制面真的启动起来，登录的 Cookie 有效期是 7200 秒（不是默认的 12 小时）", async () => {
		const cp = await spawnControlPlane({
			SFLY_ADMIN_LOGIN: "root",
			SFLY_ADMIN_PASSWORD: "admin-password-1",
			SFLY_LOGIN_IDLE_HOURS: "2",
		});
		try {
			const res = await fetch(`${cp.httpUrl}/auth/login`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ login_name: "root", password: "admin-password-1" }),
			});

			expect(res.status, cp.output()).toBe(200);
			expect(res.headers.get("set-cookie")).toContain("Max-Age=7200");
		} finally {
			await cp.stop();
		}
	}, 120_000);

	it("字符串类：对外地址、网关地址、镜像、跨域名单、代理信任都生效（安装脚本里的地址、预检的响应头、日志里的来源地址）", async () => {
		const grpcPort = await freePort();
		const cp = await spawnControlPlane({
			SFLY_PUBLIC_URL: " https://sfly.example.com/sfly/ ",
			// 网关的对外地址没有写：用对外地址的主机名加网关的端口算（启动时就算好了）。
			SFLY_GRPC_PORT: String(grpcPort),
			SFLY_PYPI_MIRROR: "https://mirrors.example.com/pypi/simple",
			SFLY_GITHUB_RELEASE_MIRROR: "https://mirrors.example.com/github-release",
			SFLY_CORS_ORIGINS: "https://Dash.Example.com:443",
			SFLY_TRUST_PROXY: "1",
		});
		try {
			const script = await (await fetch(`${cp.httpUrl}/install.sh`)).text();
			expect(script).toContain("https://sfly.example.com/sfly");
			expect(script).not.toContain("https://sfly.example.com/sfly/ ");
			expect(script).toContain(`http://sfly.example.com:${grpcPort}`);
			expect(script).toContain("https://mirrors.example.com/pypi/simple");
			expect(script).toContain("https://mirrors.example.com/github-release");

			// 跨域名单：规范成浏览器发来的写法，名单里的来源得到允许，名单外的没有。
			const allowed = await fetch(`${cp.httpUrl}/health`, {
				headers: { origin: "https://dash.example.com" },
			});
			expect(allowed.headers.get("access-control-allow-origin")).toBe("https://dash.example.com");
			const denied = await fetch(`${cp.httpUrl}/health`, {
				headers: { origin: "https://evil.example.com" },
			});
			expect(denied.headers.get("access-control-allow-origin")).toBeNull();

			// 信任一层代理：访问日志里的来源地址是 X-Forwarded-For 最右边的那个，不是直连的 127.0.0.1。
			await fetch(`${cp.httpUrl}/health`, { headers: { "x-forwarded-for": "203.0.113.7" } });
			await vi.waitFor(() => expect(cp.output()).toContain('"remoteAddress":"203.0.113.7"'), {
				timeout: 10_000,
			});
		} finally {
			await cp.stop();
		}
	}, 120_000);

	it("SFLY_PUBLIC_GRPC_URL 写了就用它，不用对外地址算出来的", async () => {
		const cp = await spawnControlPlane({
			SFLY_PUBLIC_URL: "https://sfly.example.com",
			SFLY_PUBLIC_GRPC_URL: "https://grpc.example.com:8443",
		});
		try {
			const script = await (await fetch(`${cp.httpUrl}/install.sh`)).text();
			expect(script).toContain("https://grpc.example.com:8443");
		} finally {
			await cp.stop();
		}
	}, 120_000);
});
