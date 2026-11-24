// 控制面读的数值类（#577）和字符串类（#619）环境变量在启动时就检查：用真实的 `src/main.ts`（和 `pnpm start` 一样用 tsx 运行）试。
// 数据库地址故意填一个连不上的：过了检查的值会走到连数据库那一步才失败，没过的在那之前就退出（退出码 1），
// 信息写着环境变量的名字和范围（数值类的回显填的值，最多 12 个字符；别的不回显），几个变量都不合法时一次报完。逐个变量的取值范围在 env-settings.test.ts，
// 这里守的是 `main.ts` 的接线：每个变量都经过检查，把任何一个改回原来的读法（`positive()`、`Number(...)`），对应那一行就红；
// 还有报错回显的总表（每个变量 × 带凭据的各种形状，走真的 main.ts，输出全文里没有凭据）、检查过的设置真的传给了控制面。
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
	NUMERIC_ENV_NAMES,
	readEnvSettings,
	STRING_ENV_NAMES,
} from "../src/config/env-settings.js";
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
		"%s=%s：启动时就报错退出，信息写着变量名、认得的填的值和范围",
		async (name, value, range) => {
			const result = await startMain({ [name]: value });

			expect(result.code, result.output).toBe(1);
			expect(result.output).toContain(`${name} 不合法`);
			// 像数的原样回显；`abc` 这样不像数的不回显（echo.ts：认得的才回显）。
			expect(result.output).toContain(value === "abc" ? "（认不出，没有回显）" : `"${value}"`);
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
		// 启动失败也会打印「控制面没有启动：…」（#578，写库失败等），所以这里分不出「没过检查」和「连数据库失败」的是它：
		// 看原因，过了检查之后才走到的连数据库那一步，写着连不上（1 号端口没有人监听）。
		expect(result.output).toContain("ECONNREFUSED");
	}, 90_000);
});

/** 会出现在密码、地址里的凭据位置的记号：输出里不能有它（哪怕是一部分）。 */
const SECRET = "Hunter2-secret-9f3a";

/** 每个字符串类变量一个不合法的值：说明里要有变量名、哪里不对（第几项……）和要求里的一句话；填的值（这些变量一律不回显）不能出现。 */
const BAD_STRINGS: Array<[name: string, value: string, where: string, requirement: string]> = [
	["SFLY_TRUST_PROXY", "banana", "第 1 项", "代理的层数"],
	["SFLY_CORS_ORIGINS", "bad.internal", "里的第 1 项不是来源", "协议://主机"],
	["SFLY_DEV_ORIGINS", "localhost:3000x y", "里的第 1 项不是来源", "协议://主机"],
	["SFLY_ADMIN_LOGIN", "root", "", "要一起设置"],
	["SFLY_ADMIN_PASSWORD", SECRET, "", "要一起设置"],
	["SFLY_PUBLIC_URL", "sfly.internal:8080", "", "http 或 https"],
	["SFLY_PUBLIC_URL", "http//sfly:8080", "", "http 或 https"],
	["SFLY_PUBLIC_URL", `https://admin:${SECRET}@sfly.example.com:8443/p?x=1`, "", "http 或 https"],
	["SFLY_PUBLIC_GRPC_URL", "grpc.example.com:50051", "", "http 或 https"],
	["DATABASE_URL", `postgres://sfly:${SECRET}@db:abc/sfly`, "没有回显填的值", "Unix 套接字"],
	["SFLY_PYPI_MIRROR", "mirror.internal", "", "http 或 https"],
	["SFLY_GITHUB_RELEASE_MIRROR", "ftp://mirror.internal", "", "http 或 https"],
];

describe("main.ts 读字符串类环境变量", () => {
	it.each(BAD_STRINGS)(
		"%s=%s：启动时就报错退出，说明里有变量名和要求，没有堆栈，没有密码",
		async (name, value, where, requirement) => {
			const result = await startMain({ [name]: value });

			expect(result.code, result.output).toBe(1);
			expect(result.output).toContain("控制面没有启动");
			expect(result.output).toContain(name);
			expect(result.output).toContain(where);
			expect(result.output).toContain(requirement);
			// 这些变量一律不回显填的值（地址的主机、名单里的一项、代理的一项、数据库地址）。
			if (!["SFLY_ADMIN_LOGIN", "SFLY_ADMIN_PASSWORD"].includes(name)) {
				expect(result.output).not.toContain(value);
			}
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
			DATABASE_URL: `postgres://sfly:${SECRET}@db:abc/sfly`,
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
		// 启动失败也会打印「控制面没有启动：…」（#578），分不出「没过检查」和「连数据库失败」的是它：看原因，过了检查之后才走到的
		// 连数据库那一步写着连不上（1 号端口没有人监听）。
		expect(result.output).toContain("ECONNREFUSED");
	}, 90_000);
});

// ---- 报错回显的总表（#619 的审查）：每个字符串类和数值类变量 × 各种带凭据的形状，走真的 main.ts，输出全文里没有凭据 ----
//
// 误填是常有的事：把带密码的数据库地址填进了对外地址，把带用户名密码的地址填进了代理信任。报错会进启动输出和容器日志，
// 谁都看得到，所以回显什么只有一处决定（src/config/echo.ts）：只有数值类回显、最多 12 个字符，别的都不回显。这张表按变量清单（env-settings.ts 的
// `STRING_ENV_NAMES`、`NUMERIC_ENV_NAMES`）逐个变量填各种形状：新加一个变量没进表，类型和下面的覆盖检查都会红。

/** 凭据的标记（用户名、密码、令牌）：输出里不能出现它们，哪怕一部分（大小写不论）。 */
const USER_MARK = "USERMARK_k3m8";
const PASSWORD_MARK = "SECRET_MARK_x7q9";
/** 密码太短时的标记（短于最小长度 8，才会被说「太短」）。 */
const SHORT_MARK = "Zq7k";
/** 放在**主机**位置的标记（地址、名单、代理、数据库地址的主机）：主机位置没有长度上限，什么都装得下。 */
const HOST_MARK = "HOSTMARK_q2w8";
/** 13 个数字的数值标记：比数值类回显的上限（12 个字符）多一个，整个、或者前 12 个都不能出现。 */
const NUMBER_MARK = "7431985206137";
/** 用来找标记的片段：整个标记，和各自末尾的一段（只回显一部分也抓得到）。 */
const MARK_PARTS = [
	USER_MARK,
	PASSWORD_MARK,
	"k3m8",
	"x7q9",
	SHORT_MARK,
	HOST_MARK,
	"q2w8",
	NUMBER_MARK,
	NUMBER_MARK.slice(0, 12),
	// 三个 MB 上限换算成字节的数（填的数乘 1048576）：它除以 1048576 就是填的数，和填的值一样不能出现。
	String(Math.floor(Number(NUMBER_MARK) * 1_048_576)),
].map((m) => m.toLowerCase());

type EnvName = (typeof STRING_ENV_NAMES)[number] | (typeof NUMERIC_ENV_NAMES)[number];

const U = USER_MARK;
const M = PASSWORD_MARK;
const H = HOST_MARK;

/** 每个变量填的形状：第 j 次启动时每个变量都填它的第 j 项（每个变量 11 项，代理信任 12 项，都是该变量不认的写法；后面几项放在主机、端口位置）。 */
const SHAPES: Record<EnvName, readonly string[]> = {
	// 对外地址（严格：不带用户名密码、? 和 #）和网关地址（再加不带路径）。
	SFLY_PUBLIC_URL: [
		`https://${U}:${M}@${H}.example.com/p`, // 用户名和密码（解析得了，主机是标记）
		`https://${U}:${M}＠host.example.com/p`, // 全角的 ＠
		`host.example.com/${M}`, // 令牌在路径里、没有协议
		`host.example.com/p?token=${M}`, // 令牌在查询串里、没有协议
		`${U}:${M}@host.example.com`, // 用户名密码、没有协议
		`https://${H}.example.com/${M}?token=${M}#${M}`, // 路径、查询串、片段（解析得了，主机是标记）
		`ftp://${U}:${M}@host.example.com:2121/${M}`, // 别的协议
		`/${M}/path`, // 一个路径
		`https://${H}.example.com/p?x=1`, // 标记在主机的位置（带了查询串）
		`http://host.example.com:${M}/p`, // 标记在端口的位置
		`${H}.example.com:8443`, // 没有协议的「主机:端口」，标记在主机
	],
	SFLY_PUBLIC_GRPC_URL: [
		`https://${U}:${M}@${H}.example.com:443`,
		`https://${U}:${M}＠host.example.com:443`,
		`host.example.com:443/${M}`,
		`host.example.com:443?token=${M}`,
		`${U}:${M}@host.example.com:443`,
		`https://${H}.example.com/${M}`,
		`ftp://${U}:${M}@host.example.com:2121/${M}`,
		`/${M}/grpc`,
		`https://${H}.example.com:443/p`, // 标记在主机，带了路径
		`http://host.example.com:${M}`,
		`${H}.example.com:50051`,
	],
	// 两个镜像：用户名密码、路径、查询串本身是允许的，所以这里是别的不合规矩的写法。
	SFLY_PYPI_MIRROR: [
		`https://${U}:${M}@host.example.com:abc/p`,
		`https://${U}:${M}＠host.example.com/p`,
		`host.example.com/${M}`,
		`host.example.com/p?token=${M}`,
		`${U}:${M}@host.example.com`,
		`ftp://${U}:${M}@${H}.example.com:2121/p?x=${M}`,
		`http//${U}:${M}@host.example.com/${M}`,
		`https://host.example.com:${M}/p`,
		`ftp://${H}.example.com/p`, // 标记在主机，别的协议
		`http://${H}.example.com:${M}/p`, // 主机和端口都是标记
		`${H}.example.com:8080/simple`,
	],
	SFLY_GITHUB_RELEASE_MIRROR: [
		`https://${U}:${M}@host.example.com:abc/p`,
		`https://${U}:${M}＠host.example.com/p`,
		`host.example.com/${M}`,
		`host.example.com/p?token=${M}`,
		`${U}:${M}@host.example.com`,
		`ftp://${U}:${M}@${H}.example.com:2121/p?x=${M}`,
		`http//${U}:${M}@host.example.com/${M}`,
		`/${M}/mirror`, // GitHub Release 镜像不认裸的绝对路径
		`ftp://${H}.example.com/p`,
		`http://${H}.example.com:${M}/p`,
		`${H}.example.com:8080/github-release`,
	],
	// 来源名单（逗号分隔）：其中一项带凭据，或者整个是别的写法。
	SFLY_CORS_ORIGINS: [
		`https://ok.example.com,${U}:${M}@host.example.com`,
		`https://ok.example.com, https://${U}:${M}＠host.example.com`,
		`https://ok.example.com,host.example.com/${M}`,
		`host.example.com/p?token=${M}`,
		`${U}:${M}@host.example.com`,
		`postgres://${U}:${M}@${H}:5432/sfly?x=${M}`,
		`file://host.example.com/${M}?token=${M}`,
		`/${M}/origin`,
		`https://ok.example.com,${H}.example.com`, // 标记在主机，没有协议
		`https://ok.example.com,https://host.example.com:${M}`, // 标记在端口
		`${H}.example.com:3000`,
	],
	SFLY_DEV_ORIGINS: [
		`http://localhost:3000,${U}:${M}@host.example.com`,
		`http://localhost:3000, https://${U}:${M}＠host.example.com`,
		`http://localhost:3000,host.example.com/${M}`,
		`host.example.com/p?token=${M}`,
		`${U}:${M}@host.example.com`,
		`postgres://${U}:${M}@${H}:5432/sfly?x=${M}`,
		`file://host.example.com/${M}?token=${M}`,
		`/${M}/origin`,
		`http://localhost:3000,${H}.example.com`,
		`http://localhost:3000,https://host.example.com:${M}`,
		`${H}.example.com:3000`,
	],
	// 代理信任：地址段、层数、关键字之外的写法，其中一项带凭据。
	SFLY_TRUST_PROXY: [
		`https://${U}:${M}@proxy.internal`,
		`${U}:${M}＠proxy.internal`,
		`proxy.internal/${M}`,
		`10.0.0.1?token=${M}`,
		`10.0.0.0/8,${U}:${M}@proxy.internal`,
		M,
		`10.0.0.0/8,${M}`,
		`${U}:${M}@10.0.0.1`,
		`10.0.0.1,${H}`, // 标记是一项代理的名字
		`10.0.0.1:${M}`, // 标记在端口的位置
		`${H}.proxy.internal:3128`,
		NUMBER_MARK, // 13 个数字：当作代理的层数（上限 10），说明里不回显
	],
	// 数据库地址：连接库也解析不了的写法（端口写错、多个主机、全角的 ＠、括号不成对）；其中有不带 @ 的。
	DATABASE_URL: [
		`postgres://${U}:${M}@db.internal:abc/sfly`,
		`postgres://${U}:${M}＠db.internal/sfly`,
		`postgres://db.internal:abc/${M}`, // 没有 @：令牌在路径里
		`postgres://db.internal:abc/sfly?password=${M}`, // 没有 @：令牌在查询串里
		`postgres://${U}:${M}@h1:5432,h2:5432/sfly`,
		`postgres://${U}:${M}@db.internal:99999/sfly`,
		`postgres://db.internal:${M}/sfly`, // 端口是令牌
		`postgres://${U}:${M}@[::1/sfly`,
		// 连接库拒绝、通用的地址解析却解析得了，标记在主机的位置（#642 复审：说明后面接上地址的任何一部分都得红）。
		`postgres://${U}:${M}@${H}/sfly?sslcert=/nonexistent/${M}.crt`, // 证书文件不存在
		`postgres://${U}:${M}@${H}/sfly?uselibpqcompat=true&sslmode=verify-ca`, // verify-ca 没有根证书
		`${U}:${M}@${H}/sfly`, // 带用户名密码、没有 ://（连接库会把整串当库名）
	],
	// 初始管理员：登录名不合规矩（密码一并设置，才会检查登录名）；密码和显示名不会被回显。
	SFLY_ADMIN_LOGIN: [
		`${U}:${M}@host.example.com`,
		`${M}!`,
		`${U}:${M}＠host`,
		`https://${U}:${M}@host.example.com`,
		`${M}/${U}`,
		`${M}?token=${M}`,
		M,
		`${U} ${M}`,
		`${H} ${M}`,
		`${H}!`,
		`${U}:${H}`,
	],
	SFLY_ADMIN_PASSWORD: [M],
	SFLY_ADMIN_DISPLAY_NAME: [M],
	// 数值类：填成别的变量的值（地址、令牌、带凭据的写法）。
	SFLY_RETENTION_DAYS: numberShapes(),
	SFLY_METRIC_RETENTION_DAYS: numberShapes(),
	SFLY_LOG_LIMIT_MB: numberShapes(),
	SFLY_ARTIFACT_LIMIT_MB: numberShapes(),
	SFLY_METRIC_LIMIT_MB: numberShapes(),
	SFLY_LOGIN_IDLE_HOURS: numberShapes(),
	SFLY_HTTP_PORT: numberShapes(),
	SFLY_GRPC_PORT: numberShapes(),
};

/** 数值类变量填的形状：不是数，带着别的变量的值。 */
function numberShapes(): string[] {
	return [
		`postgres://${U}:${M}@db.internal:5432/sfly`,
		`https://${U}:${M}＠host.example.com/p`,
		M,
		`1,${M}`,
		`${U}:${M}@host.example.com`,
		`30${M}`,
		`${M}.example.com/p?token=${M}`,
		`0x${M}`,
		NUMBER_MARK, // 13 个数字：比回显的上限多一个，不回显
		H,
		`${H}.example.com:${M}`,
	];
}

/** 一次启动：填的变量、要求说明里一定出现的变量（每个一条）、和要不要在检查之后才失败（连数据库）。 */
interface Scenario {
	label: string;
	env: Record<string, string>;
	/** 一定被检查拒绝的变量：输出里每个一条（「N 个环境变量不合法」的 N）。 */
	rejects: readonly string[];
}

/** 12 次启动，每个变量在第 j 次填它的第 j 项（项数不足 12 的变量从头再来）。 */
const SHAPE_COUNT = 12;
const JOINT: Scenario[] = Array.from({ length: SHAPE_COUNT }, (_, j) => {
	const env = Object.fromEntries(
		Object.entries(SHAPES).map(([name, shapes]) => [name, shapes[j % shapes.length] as string]),
	);
	return {
		label: `每个变量填第 ${j + 1} 种形状`,
		env,
		// 登录名不合规矩时不再检查密码（说明只有登录名这一条）；显示名没有要检查的写法；别的都被拒绝。
		rejects: Object.keys(SHAPES).filter(
			(name) => name !== "SFLY_ADMIN_PASSWORD" && name !== "SFLY_ADMIN_DISPLAY_NAME",
		),
	};
});
const ADMIN_SCENARIOS: Scenario[] = [
	{
		label: "只设置了管理员密码（密码是标记）：要一起设置",
		env: { SFLY_ADMIN_PASSWORD: M },
		rejects: ["SFLY_ADMIN_PASSWORD"],
	},
	{
		label: "管理员密码太短（密码是短标记）：不合规矩，不回显密码",
		env: { SFLY_ADMIN_LOGIN: "root", SFLY_ADMIN_PASSWORD: SHORT_MARK },
		rejects: ["SFLY_ADMIN_PASSWORD"],
	},
];

describe("main.ts：报错回显的总表（每个变量 × 带凭据的各种形状，输出全文里没有凭据）", () => {
	it.each([
		...JOINT,
		...ADMIN_SCENARIOS,
	])("$label：退出码 1，每个不合法的变量一条，没有堆栈，输出全文里没有用户名、密码、令牌", async ({
		env,
		rejects,
	}) => {
		const result = await startMain(env);

		expect(result.code, result.output).toBe(1);
		expect(result.output).toContain("控制面没有启动");
		for (const name of rejects) expect(result.output, name).toContain(name);
		if (rejects.length > 1) expect(result.output).toContain(`${rejects.length} 个环境变量不合法`);
		// 不是未捕获的错误，也没有走到连数据库那一步。
		expect(result.output).not.toMatch(/\n\s+at /);
		expect(result.output).not.toContain("ECONNREFUSED");
		const lower = result.output.toLowerCase();
		for (const part of MARK_PARTS) expect(lower, part).not.toContain(part);
	}, 90_000);

	it("管理员的登录名、密码、显示名都合规矩（显示名是标记）：通过检查，之后才在连数据库那一步失败，输出里没有它们", async () => {
		const result = await startMain({
			SFLY_ADMIN_LOGIN: "root",
			SFLY_ADMIN_PASSWORD: `${M}-long-enough`,
			SFLY_ADMIN_DISPLAY_NAME: M,
		});

		expect(result.code, result.output).not.toBe(0);
		expect(result.output).not.toContain("不合法");
		// 启动失败也会打印「控制面没有启动：…」（#578），分不出「没过检查」和「连数据库失败」的是它：看原因，过了检查之后才走到的
		// 连数据库那一步写着连不上（1 号端口没有人监听）。
		expect(result.output).toContain("ECONNREFUSED");
		const lower = result.output.toLowerCase();
		for (const part of MARK_PARTS) expect(lower, part).not.toContain(part);
	}, 90_000);

	it("几个变量同时不合法时，说明按固定的顺序排（读的顺序，写在 docs/ARCHITECTURE.md「启动时检查哪些环境变量」）", async () => {
		const order = [
			"SFLY_GRPC_PORT",
			"SFLY_PUBLIC_URL",
			"SFLY_PUBLIC_GRPC_URL",
			"SFLY_RETENTION_DAYS",
			"SFLY_METRIC_RETENTION_DAYS",
			"SFLY_LOG_LIMIT_MB",
			"SFLY_ARTIFACT_LIMIT_MB",
			"SFLY_METRIC_LIMIT_MB",
			"SFLY_LOGIN_IDLE_HOURS",
			"SFLY_HTTP_PORT",
			"DATABASE_URL",
			"SFLY_TRUST_PROXY",
			"SFLY_CORS_ORIGINS",
			"SFLY_DEV_ORIGINS",
			"SFLY_ADMIN_LOGIN",
			"SFLY_PYPI_MIRROR",
			"SFLY_GITHUB_RELEASE_MIRROR",
		];
		const [first] = JOINT;
		const result = await startMain(first?.env ?? {});

		const positions = order.map((name) => result.output.indexOf(`  - ${name} `));
		expect(
			positions.every((position) => position >= 0),
			result.output,
		).toBe(true);
		expect(positions, result.output).toEqual([...positions].sort((a, b) => a - b));
	}, 90_000);

	it("表里的变量和 env-settings.ts 的变量清单一样：新加一个变量没进表就红", () => {
		expect(Object.keys(SHAPES).sort()).toEqual([...STRING_ENV_NAMES, ...NUMERIC_ENV_NAMES].sort());
		for (const [name, shapes] of Object.entries(SHAPES)) {
			expect(shapes.length, name).toBeGreaterThan(0);
		}
	});

	it("地址类、名单类、代理类的变量都有标记放在主机位置的形状；数值类的有 13 位数的形状（回显的上限是 12 个字符）", () => {
		const hostPosition = [
			"SFLY_PUBLIC_URL",
			"SFLY_PUBLIC_GRPC_URL",
			"SFLY_PYPI_MIRROR",
			"SFLY_GITHUB_RELEASE_MIRROR",
			"SFLY_CORS_ORIGINS",
			"SFLY_DEV_ORIGINS",
			"SFLY_TRUST_PROXY",
			"DATABASE_URL",
		] as const;
		for (const name of hostPosition) {
			expect(
				SHAPES[name].some((shape) => shape.includes(H)),
				name,
			).toBe(true);
		}
		for (const name of NUMERIC_ENV_NAMES) {
			expect(SHAPES[name], name).toContain(NUMBER_MARK);
		}
		expect(NUMBER_MARK).toHaveLength(13);
		// 数据库地址里「连接库拒绝、通用的地址解析却解析得了」的两种，和没有 :// 的一种。
		const database = SHAPES.DATABASE_URL.join("\n");
		expect(database).toContain(`${H}/sfly?sslcert=`);
		expect(database).toContain("uselibpqcompat=true&sslmode=verify-ca");
	});

	it("读设置只读清单里的变量，清单里的变量也都读了：绕开清单读一个变量、或者清单里留着没读的变量都会红", () => {
		const read = new Set<string>();
		const record = (key: string | symbol) => {
			if (typeof key === "string") read.add(key);
		};
		const env = new Proxy<Record<string, string | undefined>>(
			// 有初始管理员，才会读显示名。
			{ SFLY_ADMIN_LOGIN: "root", SFLY_ADMIN_PASSWORD: "admin-password-1" },
			{
				get(target, key) {
					record(key);
					return Reflect.get(target, key);
				},
				has(target, key) {
					record(key);
					return Reflect.has(target, key);
				},
				ownKeys(target) {
					for (const key of Reflect.ownKeys(target)) record(key);
					return Reflect.ownKeys(target);
				},
			},
		);

		readEnvSettings(env);

		expect([...read].sort()).toEqual([...STRING_ENV_NAMES, ...NUMERIC_ENV_NAMES].sort());
	});
});

describe("main.ts 的子命令 reset-password 读 DATABASE_URL 和控制面是同一个函数", () => {
	it("连接库解析不了的地址：和控制面一样，一句固定的说明、退出码 1、没有填的值、没有堆栈", async () => {
		const bad = `postgres://${U}:${M}@db.internal:abc/sfly`;
		let output = "";
		let code: number | string | undefined;
		try {
			await run(process.execPath, ["--import", "tsx", "src/main.ts", "reset-password", "root"], {
				cwd: serverDir,
				env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATABASE_URL: bad },
				timeout: 60_000,
			});
			code = 0;
		} catch (error) {
			const failed = error as { code?: number | string; stderr?: string; stdout?: string };
			code = failed.code;
			output = `${failed.stderr ?? ""}${failed.stdout ?? ""}`;
		}

		expect(code, output).toBe(1);
		expect(output).toContain("DATABASE_URL 不合法");
		expect(output).toContain("Unix 套接字");
		expect(output).not.toMatch(/\n\s+at /);
		const lower = output.toLowerCase();
		for (const part of MARK_PARTS) expect(lower, part).not.toContain(part);
	}, 90_000);
});

/** 起一个真的控制面进程（连真的数据库）：返回它的 HTTP 地址、到目前为止的输出和停止它的办法。 */
async function spawnControlPlane(
	settings: Record<string, string>,
	/** 给控制面的数据库地址（默认就是测试库的地址）。 */
	databaseUrl: (url: string) => string = (url) => url,
) {
	const database = await createTestDatabase("sfly_main_env");
	const dataDir = await mkdtemp(join(tmpdir(), "sfly-main-env-"));
	const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
		cwd: serverDir,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: process.env.HOME ?? "",
			DATABASE_URL: databaseUrl(database.url),
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

	// 值都带前后空白：检查过的（去掉空白的）设置真的传进去了，没有被 main.ts 里别处的旧读法（原样的环境变量）盖掉。
	it("字符串类：对外地址、网关地址、镜像、跨域名单、代理信任都生效（安装脚本里的地址、预检的响应头、日志里的来源地址）；值带前后空白", async () => {
		const grpcPort = await freePort();
		const cp = await spawnControlPlane(
			{
				SFLY_PUBLIC_URL: " https://sfly.example.com/sfly/ ",
				// 网关的对外地址没有写：用对外地址的主机名加网关的端口算（启动时就算好了）。
				SFLY_GRPC_PORT: String(grpcPort),
				SFLY_PYPI_MIRROR: "  https://mirrors.example.com/pypi/simple  ",
				SFLY_GITHUB_RELEASE_MIRROR: "\thttps://mirrors.example.com/github-release ",
				SFLY_CORS_ORIGINS: " https://Dash.Example.com:443 ",
				SFLY_TRUST_PROXY: " 1 ",
			},
			// 数据库地址也带前后空白：控制面照样连得上。
			(url) => `  ${url}  `,
		);
		try {
			const script = await (await fetch(`${cp.httpUrl}/install.sh`)).text();
			// 安装脚本里的值是去掉空白的（模板里是 NAME='值'：带空白的原文会写成 NAME=' 值 '）。
			expect(script).toContain("SFLY_URL='https://sfly.example.com/sfly'");
			expect(script).toContain(`SFLY_GRPC_URL='http://sfly.example.com:${grpcPort}'`);
			expect(script).toContain("PYPI_MIRROR='https://mirrors.example.com/pypi/simple'");
			expect(script).toContain(
				"GITHUB_RELEASE_MIRROR='https://mirrors.example.com/github-release'",
			);

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

	it("SFLY_PUBLIC_GRPC_URL（带前后空白）写了就用它，不用对外地址算出来的", async () => {
		const cp = await spawnControlPlane({
			SFLY_PUBLIC_URL: "https://sfly.example.com",
			SFLY_PUBLIC_GRPC_URL: "  https://grpc.example.com:8443  ",
		});
		try {
			const script = await (await fetch(`${cp.httpUrl}/install.sh`)).text();
			expect(script).toContain("SFLY_GRPC_URL='https://grpc.example.com:8443'");
		} finally {
			await cp.stop();
		}
	}, 120_000);

	// SFLY_DEV_ORIGINS：开发时 vite 的地址，登录 Cookie 的跨站检查把它当同源（没有它，从那个地址发来的写请求不被当作已登录）。
	it("SFLY_DEV_ORIGINS（带前后空白、不规范的写法）从 main.ts 传到了控制面：名单里的来源带登录 Cookie 的写请求被当作已登录，名单外的不是", async () => {
		const cp = await spawnControlPlane({
			SFLY_ADMIN_LOGIN: "root",
			SFLY_ADMIN_PASSWORD: "admin-password-1",
			SFLY_PUBLIC_URL: "https://sfly.example.com",
			SFLY_DEV_ORIGINS: "  http://Localhost:5173/ , http://dev.example.com:3000  ",
		});
		try {
			const login = await fetch(`${cp.httpUrl}/auth/login`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ login_name: "root", password: "admin-password-1" }),
			});
			expect(login.status, cp.output()).toBe(200);
			const cookie = /sfly_login=([^;]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1] ?? "";
			const write = (origin: string) =>
				fetch(`${cp.httpUrl}/orchestrations`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						cookie: `sfly_login=${cookie}`,
						origin,
					},
					body: JSON.stringify({ name: "场景" }),
				});

			// 名单里的来源（规范成小写、去掉路径）：Cookie 有效，身份来自登录，不需要昵称。
			expect((await write("http://localhost:5173")).status).toBe(201);
			expect((await write("http://dev.example.com:3000")).status).toBe(201);
			// 对外地址同源。
			expect((await write("https://sfly.example.com")).status).toBe(201);
			// 名单外的来源：Cookie 不被承认，没有昵称就是 400。
			const denied = await write("http://evil.example.com");
			expect(denied.status).toBe(400);
			expect(await denied.text()).toContain("nickname_required");
		} finally {
			await cp.stop();
		}
	}, 120_000);
});

// 检查过的设置（`readEnvSettings` 的结果，除了端口）用 `...settings` 一次交给控制面：漏掉一项就是悄悄不生效。
// 类型把 `EnvSettings` 的键和 `ControlPlaneOptions` 绑在一起（键名写错、类型对不上编译不过，前面有同名的项也编译不过）；
// 剩下编译拦不住的是放在 `...settings` 后面、把它盖掉的项（例如 `pypiMirror: env.SFLY_PYPI_MIRROR`），这里读 main.ts 的语法树检查。
describe("main.ts：检查过的设置整个交给控制面，没有别处盖掉它们", () => {
	it("startControlPlane 的选项里 `...settings` 是最后一项，其余的项没有和设置同名的", async () => {
		const source = await readFile(join(serverDir, "src/main.ts"), "utf8");
		const file = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
		const calls: ts.ObjectLiteralExpression[] = [];
		const visit = (node: ts.Node) => {
			const [options] = ts.isCallExpression(node) ? node.arguments : [];
			if (
				ts.isCallExpression(node) &&
				ts.isIdentifier(node.expression) &&
				node.expression.text === "startControlPlane" &&
				options !== undefined &&
				ts.isObjectLiteralExpression(options)
			) {
				calls.push(options);
			}
			ts.forEachChild(node, visit);
		};
		visit(file);
		expect(calls, "main.ts 里要有一处 startControlPlane({...})").toHaveLength(1);
		const properties = calls[0]?.properties ?? [];

		const last = properties.at(-1);
		expect(
			last !== undefined &&
				ts.isSpreadAssignment(last) &&
				ts.isIdentifier(last.expression) &&
				last.expression.text === "settings",
			"`...settings` 要是 startControlPlane 选项的最后一项（后面再有同名的项，就把检查过的设置盖掉了）",
		).toBe(true);

		const settingKeys = new Set(Object.keys(readEnvSettings({})));
		const explicit = properties.flatMap((property) =>
			property.name !== undefined &&
			(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
				? [property.name.text]
				: [],
		);
		expect(
			explicit.filter((name) => settingKeys.has(name)),
			"这些项是检查过的设置，不要再另外传（由 `...settings` 传）",
		).toEqual([]);
	});
});
