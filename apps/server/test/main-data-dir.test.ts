// 数据目录写不了时控制面启动就失败（#651）：用真的 `src/main.ts`（和 `pnpm start` 一样用 tsx 运行）。
// 数据库地址故意填一个连不上的：过了检查的值会走到连数据库那一步（ECONNREFUSED），没过的在那之前就退出（退出码 1）。
// 说明写目录、当前用户和怎么改，不打印堆栈；和别的环境变量的问题一起报。以 root 运行时目录权限拦不住，那几条跳过。
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const serverDir = join(import.meta.dirname, "..");
const isRoot = process.getuid?.() === 0;

async function startMain(settings: Record<string, string>) {
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "",
		DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:1/none",
		SFLY_HTTP_PORT: "0",
		SFLY_GRPC_PORT: "0",
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

describe("main.ts：数据目录写不了", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "sfly-main-data-dir-"));
	});
	afterEach(async () => {
		await chmod(root, 0o755).catch(() => {});
		await rm(root, { recursive: true, force: true });
	});

	it.skipIf(isRoot)(
		"目录只读：退出码 1，说明写目录、当前用户、怎么改，没有堆栈，没有走到连数据库那一步",
		async () => {
			await chmod(root, 0o555);

			const result = await startMain({ SFLY_DATA_DIR: root });

			expect(result.code, result.output).toBe(1);
			expect(result.output).toContain("控制面没有启动");
			expect(result.output).toContain("SFLY_DATA_DIR 指的数据目录不可写");
			expect(result.output).toContain(root);
			expect(result.output).toContain(userInfo().username);
			expect(result.output).toContain("chown");
			expect(result.output).not.toMatch(/\n\s+at /);
			expect(result.output).not.toContain("ECONNREFUSED");
		},
		90_000,
	);

	it.skipIf(isRoot)(
		"目录只读又有别的环境变量写错：一次报完，两条，说明里写「启动检查没通过」",
		async () => {
			await chmod(root, 0o555);

			const result = await startMain({ SFLY_DATA_DIR: root, SFLY_LOG_LIMIT_MB: "Infinity" });

			expect(result.code, result.output).toBe(1);
			expect(result.output).toContain("2 个启动检查没通过");
			expect(result.output).toContain("SFLY_DATA_DIR 指的数据目录不可写");
			expect(result.output).toContain("SFLY_LOG_LIMIT_MB");
			expect(result.output).not.toMatch(/\n\s+at /);
		},
		90_000,
	);

	it("数据目录写成地址（环境变量的问题，不去碰文件系统）：只报这一条，不回显填的值，没有创建奇怪的目录", async () => {
		const before = await readdir(serverDir);

		const result = await startMain({
			SFLY_DATA_DIR: "postgres://sfly:Hunter2-secret-9f3a@db.internal:5432/sfly",
		});

		expect(result.code, result.output).toBe(1);
		expect(result.output).toContain("SFLY_DATA_DIR 不合法");
		expect(result.output).not.toContain("Hunter2");
		expect(result.output).not.toContain("postgres");
		expect(await readdir(serverDir)).toEqual(before);
	}, 90_000);

	it("目录可写：通过检查，之后才在连数据库那一步失败；目录里没有留下试写的文件", async () => {
		const result = await startMain({ SFLY_DATA_DIR: root });

		expect(result.code, result.output).not.toBe(0);
		expect(result.output).not.toContain("SFLY_DATA_DIR");
		expect(result.output).toContain("ECONNREFUSED");
		expect(await readdir(root)).toEqual([]);
	}, 90_000);

	it("目录不存在、能建出来：通过检查（目录建出来了，里面没有试写的文件）", async () => {
		const dir = join(root, "new", "data");

		const result = await startMain({ SFLY_DATA_DIR: dir });

		expect(result.output).toContain("ECONNREFUSED");
		expect(await readdir(dir)).toEqual([]);
	}, 90_000);
});
