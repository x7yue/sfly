// 连真的数据库、用真的 `src/main.ts`（和 `pnpm start` 一样用 tsx 运行）起控制面（#651 的审查）：
// 1. 先查再清：数据目录写不了时启动失败，上次留下的上传临时文件（artifacts/.uploading）还在、库里没有建表（连库、迁移都没做）；
//    对照：都写得了时控制面起来，临时文件被清掉（证明走到清理那一步的话它会被删）。
// 2. 监听失败的说明里没有填的值：检查认的、监听时才失败的写法（合法的主机名的形状、IPv6 的区域标识）会走到监听那一步才失败，
//    Node 的报错会把监听地址原样带出来；现在说明只有变量名、端口、错误码和一句怎么办（util/listen-error.ts）。
//    HTTP 和 Agent 网关各一处监听，两个变量 × 各种形状，输出全文里没有填的值的任何一部分。
// 数据目录权限拦不住 root，那几条跳过。
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "./support/temp-dir.js";
import {
	createMigratedTemplate,
	createTestDatabase,
	type TestDatabase,
} from "./support/test-database.js";

const serverDir = join(import.meta.dirname, "..");
const isRoot = process.getuid?.() === 0;

/** 起 main.ts；等它退出，或者打印出「http <地址>」（起来了）；起来了的由 `stop()` 停掉。 */
async function startMain(env: Record<string, string>, databaseUrl: string) {
	const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
		cwd: serverDir,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: process.env.HOME ?? "",
			DATABASE_URL: databaseUrl,
			SFLY_HTTP_HOST: "127.0.0.1",
			SFLY_GRPC_HOST: "127.0.0.1",
			SFLY_HTTP_PORT: "0",
			SFLY_GRPC_PORT: "0",
			...env,
		},
	});
	let output = "";
	child.stdout?.on("data", (chunk) => {
		output += String(chunk);
	});
	child.stderr?.on("data", (chunk) => {
		output += String(chunk);
	});
	const exited = new Promise<number | null>((resolve) =>
		child.once("exit", (code) => resolve(code)),
	);
	const result = await new Promise<{ started: boolean; code: number | null }>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`60 秒内既没退出也没起来：${output}`)), 60_000);
		const check = setInterval(() => {
			if (/ http http:\/\/[^,\s]+/.test(output)) {
				clearTimeout(timer);
				clearInterval(check);
				resolve({ started: true, code: null });
			}
		}, 100);
		void exited.then((code) => {
			clearTimeout(timer);
			clearInterval(check);
			resolve({ started: false, code });
		});
	});
	if (child.exitCode === null) child.kill("SIGTERM");
	await exited;
	return { ...result, output };
}

async function publicTables(url: string): Promise<number> {
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		const { rows } = await client.query<{ n: number }>(
			"SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'",
		);
		return rows[0]?.n ?? -1;
	} finally {
		await client.end();
	}
}

describe("数据目录写不了时先查再清：失败的启动不碰上次留下的上传临时文件，也不连库建表", () => {
	let root: string;
	let database: TestDatabase;

	beforeEach(async () => {
		root = await makeTempDir("sfly-startup-uploading-");
		database = await createTestDatabase("sfly_startup");
	});
	afterEach(async () => {
		for (const path of [root, join(root, "logs"), join(root, "artifacts")]) {
			await chmod(path, 0o755).catch(() => {});
		}
		await rm(root, { recursive: true, force: true });
		await database.drop();
	});

	/** 上次留下的上传临时文件（artifacts/.uploading 下的 .upload-*）。 */
	async function leftover(): Promise<string> {
		const dir = join(root, "artifacts", ".uploading");
		await mkdir(dir, { recursive: true });
		const file = join(dir, ".upload-left-over");
		await writeFile(file, "half an upload");
		return file;
	}

	it.skipIf(isRoot)(
		"数据目录的根只读（artifacts 可写）：退出码 1，临时文件还在，库里没有建表",
		async () => {
			const file = await leftover();
			await chmod(root, 0o555);

			const result = await startMain({ SFLY_DATA_DIR: root }, database.url);

			expect(result.started, result.output).toBe(false);
			expect(result.code, result.output).toBe(1);
			expect(result.output).toContain("SFLY_DATA_DIR 指的数据目录不可写");
			expect(existsSync(file)).toBe(true);
			expect(await publicTables(database.url)).toBe(0);
		},
		120_000,
	);

	it.skipIf(isRoot)(
		"根可写、logs 只读：退出码 1，临时文件还在，库里没有建表",
		async () => {
			const file = await leftover();
			await mkdir(join(root, "logs"));
			await chmod(join(root, "logs"), 0o555);

			const result = await startMain({ SFLY_DATA_DIR: root }, database.url);

			expect(result.started, result.output).toBe(false);
			expect(result.code, result.output).toBe(1);
			expect(result.output).toContain("下面的 logs 目录里写不了文件");
			expect(existsSync(file)).toBe(true);
			expect(await publicTables(database.url)).toBe(0);
		},
		120_000,
	);

	it("对照：都写得了时控制面起来，临时文件被清掉，日志里写着清掉了 1 个", async () => {
		const file = await leftover();

		const result = await startMain({ SFLY_DATA_DIR: root }, database.url);

		expect(result.started, result.output).toBe(true);
		expect(existsSync(file)).toBe(false);
		expect(result.output).toContain("清掉了上次留下的 1 个上传临时文件");
	}, 120_000);
});

/** 令牌：误填进监听地址的凭据（字母数字，像主机名）。输出里不能有它的任何一段（连续 8 个字符；再短的会撞上输出里本来就有的词，比如 SFLY_ASSISTANT_SECRET 里的 secret）。 */
const TOKEN = "PwdQz5wSecret";

/** `value` 里连续 `size` 个字符的每一段（小写）。 */
const windows = (value: string, size = 8): string[] => {
	const text = value.toLowerCase();
	const found: string[] = [];
	for (let i = 0; i + size <= text.length; i++) found.push(text.slice(i, i + size));
	return found;
};

/**
 * 检查认、监听时才失败的写法：[标签, 值, 输出里不能出现的片段（令牌的每一段，加上值里令牌之外的部分）]。
 * 值都在 253 个字符以内、段在 63 个字符以内（检查认），也解析不了、或本机没有这个地址。
 */
const LISTEN_FAILS: Array<[label: string, value: string, hidden: string[]]> = [
	["令牌（像主机名）", TOKEN, windows(TOKEN)],
	[
		"令牌.example.invalid（一定解析不了的主机名）",
		`${TOKEN}.example.invalid`,
		[...windows(TOKEN), "example.invalid"],
	],
	["IPv6 带区域标识，区域标识是令牌", `fe80::1%${TOKEN}`, [...windows(TOKEN), "fe80::1%"]],
	[
		"IPv6 带区域标识，区域标识很长（总长 208 个字符）",
		`fe80::1%${TOKEN.repeat(15)}`,
		[...windows(TOKEN), "fe80::1%"],
	],
	["带下划线和连字符的令牌", "Pwd_Qz5w-Secret-9x", windows("Pwd_Qz5w-Secret-9x")],
	[
		"令牌放在 63 个字符的一段里、三段",
		[1, 2, 3].map(() => `${TOKEN}-${"x".repeat(49)}`).join("."),
		windows(TOKEN),
	],
];

const LISTENERS = [
	{ host: "SFLY_HTTP_HOST", port: "SFLY_HTTP_PORT", what: "HTTP API监听失败" },
	{ host: "SFLY_GRPC_HOST", port: "SFLY_GRPC_PORT", what: "Agent 网关监听失败" },
] as const;

describe("监听失败的说明：只有变量名、端口、错误码和一句怎么办，没有填的值", () => {
	let template: TestDatabase;
	let root: string;
	let database: TestDatabase;

	beforeAll(async () => {
		template = await createMigratedTemplate("sfly_listen_template");
	}, 120_000);
	afterAll(async () => {
		await template.drop();
	});
	beforeEach(async () => {
		root = await makeTempDir("sfly-startup-listen-");
		database = await createTestDatabase("sfly_listen", { template: template.name });
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
		await database.drop();
	});

	it.each(
		LISTENERS.flatMap((listener) =>
			LISTEN_FAILS.map(
				([label, value, hidden]) => [listener.host, label, listener, value, hidden] as const,
			),
		),
	)(
		"%s 填%s：退出码 1，说明写着变量名、端口、错误码，输出全文里没有填的值",
		async (_, __, listener, value, hidden) => {
			const result = await startMain({ SFLY_DATA_DIR: root, [listener.host]: value }, database.url);

			expect(result.started, result.output).toBe(false);
			expect(result.code, result.output).toBe(1);
			expect(result.output).toContain("控制面没有启动");
			expect(result.output).toContain(
				`${listener.what}（地址在 ${listener.host}、端口 ${listener.port}，端口 0；错误码 `,
			);
			expect(result.output).toMatch(/错误码 [A-Z][A-Z0-9_]+）/);
			// 不打印底层错误的原文（里面有 `getaddrinfo ENOTFOUND <值>`、`hostname: '<值>'`）和堆栈。
			expect(result.output).not.toContain("getaddrinfo");
			expect(result.output).not.toContain("hostname:");
			expect(result.output).not.toMatch(/\n\s+at /);
			const lower = result.output.toLowerCase();
			for (const part of hidden) expect(lower, part).not.toContain(part);
		},
		120_000,
	);

	it.each(LISTENERS.map((listener) => [listener.host, listener] as const))(
		"%s 的端口被别的进程占着：写着端口被占用和换一个端口，写出端口号和 EADDRINUSE",
		async (_, listener) => {
			const holder: Server = createServer();
			await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
			const port = String((holder.address() as { port: number }).port);
			try {
				const result = await startMain(
					{ SFLY_DATA_DIR: root, [listener.port]: port },
					database.url,
				);

				expect(result.started, result.output).toBe(false);
				expect(result.code, result.output).toBe(1);
				expect(result.output).toContain(
					`${listener.what}（地址在 ${listener.host}、端口 ${listener.port}，端口 ${port}；错误码 EADDRINUSE）`,
				);
				expect(result.output).toContain("这个端口已经被别的进程占用了");
				expect(result.output).toContain(`换一个端口（${listener.port}）`);
				expect(result.output).not.toMatch(/\n\s+at /);
			} finally {
				await new Promise<void>((resolve) => holder.close(() => resolve()));
			}
		},
		120_000,
	);
});
