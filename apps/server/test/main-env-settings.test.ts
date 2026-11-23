// 控制面读的数值类环境变量在启动时就检查（#577）：用真实的 `src/main.ts`（和 `pnpm start` 一样用 tsx 运行）试。
// 数据库地址故意填一个连不上的：过了检查的值会走到连数据库那一步才失败，没过的在那之前就退出（退出码 1），
// 信息写着环境变量的名字、填的原文和范围，几个变量都不合法时一次报完。逐个变量的取值范围在 env-settings.test.ts，
// 这里守的是 `main.ts` 的接线：每个变量都经过检查，把任何一个改回原来的读法（`positive()`、`Number(...)`），对应那一行就红。
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
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
	["SFLY_LOGIN_IDLE_HOURS", "Infinity", "大于 0、不超过 876000 的数（小时）"],
	["SFLY_LOGIN_IDLE_HOURS", "1e9", "大于 0、不超过 876000 的数（小时）"],
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

describe("main.ts：合法的值真的传给了控制面", () => {
	it("SFLY_LOGIN_IDLE_HOURS=2：控制面真的启动起来，登录的 Cookie 有效期是 7200 秒（不是默认的 12 小时）", async () => {
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
				SFLY_ADMIN_LOGIN: "root",
				SFLY_ADMIN_PASSWORD: "admin-password-1",
				SFLY_LOGIN_IDLE_HOURS: "2",
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

			const res = await fetch(`${httpUrl}/auth/login`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ login_name: "root", password: "admin-password-1" }),
			});

			expect(res.status, output).toBe(200);
			expect(res.headers.get("set-cookie")).toContain("Max-Age=7200");
		} finally {
			child.kill("SIGTERM");
			await exited;
			await database.drop();
			await rm(dataDir, { recursive: true, force: true });
		}
	}, 120_000);
});
