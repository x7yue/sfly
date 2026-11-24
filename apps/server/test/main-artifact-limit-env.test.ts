// `SFLY_ARTIFACT_LIMIT_MB` 在控制面启动时就检查（#477）：用真实的 `src/main.ts`（和 `pnpm start` 一样用 tsx 运行）试。
// 数据库地址故意填一个连不上的：过了检查的值会走到连数据库那一步才失败，没过的在那之前就退出，退出时的信息写着
// 环境变量的名字。这条把 `main.ts` 的接线守住：把它改回原来的读法（只检查大于 0），`Infinity` 会一路走到
// `startControlPlane`，报的是选项的名字（`artifactLimitBytes`）而不是环境变量的名字，这里就红。
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const serverDir = join(import.meta.dirname, "..");

async function startMain(limitMb: string | undefined) {
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "",
		// 连不上的数据库：1 号端口没有人监听，立刻 ECONNREFUSED。
		DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:1/none",
		SFLY_HTTP_PORT: "0",
		SFLY_GRPC_PORT: "0",
		SFLY_DATA_DIR: join(serverDir, "..", "..", "node_modules", ".cache", "main-env-test"),
	};
	if (limitMb !== undefined) env.SFLY_ARTIFACT_LIMIT_MB = limitMb;
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

describe("main.ts 读 SFLY_ARTIFACT_LIMIT_MB", () => {
	it.each([
		"Infinity",
		"-Infinity",
		"NaN",
		"abc",
		"0",
		"-5",
		"1e14",
		"0.0000001",
	])("%s：启动时就报错退出，信息写着环境变量的名字、认得的填的值和合法的范围", async (value) => {
		const result = await startMain(value);

		expect(result.code, result.output).not.toBe(0);
		expect(result.output).toContain("SFLY_ARTIFACT_LIMIT_MB 不合法");
		// 像数的原样回显；`abc` 这样不像数的不回显，只说认不出（src/config/echo.ts：认得的才回显）。
		expect(result.output).toContain(value === "abc" ? "（认不出，没有回显）" : `"${value}"`);
		expect(result.output).toContain("之间的整数");
	}, 90_000);

	it.each([
		["不设置", undefined],
		["空串", ""],
		["正常的值", "1024"],
		["带小数的值", "0.5"],
	])(
		"%s：通过检查，之后才在连数据库那一步失败（不是因为上限）",
		async (_, value) => {
			const result = await startMain(value);

			expect(result.code, result.output).not.toBe(0);
			expect(result.output).not.toContain("不合法");
			expect(result.output).not.toContain("SFLY_ARTIFACT_LIMIT_MB");
		},
		90_000,
	);
});
