// 控制面读的字符串类环境变量也在启动时和数值类的一起检查（#619，接 #577）：代理信任、跨域来源、初始管理员、对外地址、
// 数据库地址、镜像地址。写错了的都收进同一条 EnvSettingsError，一次报完；退出码 1、不打印堆栈（main.ts 接住它，见
// main-env-settings.test.ts）。启动检查不比真正用这个值的一方更严（数据库地址：连接库认的写法都过；镜像：uv 认的
// `file://` 和绝对路径都过）；报错里回显什么只有一处决定（echo.ts，认得的才回显）：这里每个变量单独断言说明里写了什么，
// 「每个变量 × 各种带凭据的形状」的总表在 main-env-settings.test.ts（走真的 main.ts）和 echo.test.ts。
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { EnvSettingsError, readEnvSettings } from "../src/config/env-settings.js";

const run = promisify(execFile);

/** 会出现在密码、地址里的凭据位置的记号：说明里不能有它（哪怕是一部分）。 */
const SECRET = "Hunter2-secret-9f3a";
/** 放在主机、端口位置的标记：地址类、名单类、代理类的变量，说明里不能有它的任何一部分（回显收到只剩数值类，#619）。 */
const HOST_MARK = "HOSTMARK-q2w8";

/** 读环境变量，返回不合法的说明（没有问题时失败）。 */
function problemsOf(env: Record<string, string>): string[] {
	try {
		readEnvSettings(env);
	} catch (error) {
		expect(error).toBeInstanceOf(EnvSettingsError);
		return [...(error as EnvSettingsError).problems];
	}
	throw new Error(`${JSON.stringify(Object.keys(env))} 应该被拒绝，却通过了`);
}

/** 只有一个变量不合法时的说明。 */
function oneProblem(env: Record<string, string>): string {
	const problems = problemsOf(env);
	expect(problems).toHaveLength(1);
	return problems[0] as string;
}

describe("什么都不设置：字符串类的设置都用默认值", () => {
	it("没有信任的代理、不限来源、没有初始管理员、没有对外地址、默认的数据库地址、没有镜像", () => {
		expect(readEnvSettings({})).toMatchObject({
			trustProxy: false,
			corsOrigins: undefined,
			sameOrigins: undefined,
			initialAdmin: undefined,
			publicHttpUrl: undefined,
			publicGrpcUrl: undefined,
			databaseUrl: "postgres://sfly:sfly@127.0.0.1:5432/sfly",
			pypiMirror: undefined,
			githubReleaseMirror: undefined,
		});
	});

	it("空串和只有空白当作没设置（和 docker compose 里 `${VAR:-}` 展开成空串一致）", () => {
		const blank = {
			SFLY_TRUST_PROXY: "  ",
			SFLY_CORS_ORIGINS: "",
			SFLY_DEV_ORIGINS: " ",
			SFLY_ADMIN_LOGIN: "",
			SFLY_ADMIN_PASSWORD: "",
			SFLY_PUBLIC_URL: "",
			SFLY_PUBLIC_GRPC_URL: "  ",
			DATABASE_URL: "",
			SFLY_PYPI_MIRROR: "",
			SFLY_GITHUB_RELEASE_MIRROR: " ",
		};
		expect(readEnvSettings(blank)).toMatchObject({
			trustProxy: false,
			corsOrigins: undefined,
			initialAdmin: undefined,
			publicHttpUrl: undefined,
			publicGrpcUrl: undefined,
			databaseUrl: "postgres://sfly:sfly@127.0.0.1:5432/sfly",
			pypiMirror: undefined,
		});
	});
});

describe("SFLY_TRUST_PROXY", () => {
	it("合法的写法换成设置：层数是函数，地址段原样", () => {
		expect(typeof readEnvSettings({ SFLY_TRUST_PROXY: "1" }).trustProxy).toBe("function");
		expect(readEnvSettings({ SFLY_TRUST_PROXY: "127.0.0.1, 10.0.0.0/8" }).trustProxy).toBe(
			"127.0.0.1,10.0.0.0/8",
		);
		expect(readEnvSettings({ SFLY_TRUST_PROXY: "false" }).trustProxy).toBe(false);
	});

	it.each([
		["banana", "第 1 项", "banana"],
		["10.0.0.0/33", "第 1 项", "10.0.0.0/33"],
		["10.0.0.0/8,oops", "第 2 项", "oops"],
		// 层数写大了：是个数（不超过 12 个字符才回显）。
		["11", '实际是 "11"', undefined],
	])("写错了（%s）：报变量名和第几项，不回显填的那一项，不是带堆栈的未捕获错误", (value, where, hidden) => {
		const problem = oneProblem({ SFLY_TRUST_PROXY: value });

		expect(problem).toContain("SFLY_TRUST_PROXY");
		expect(problem).toContain(where);
		if (hidden !== undefined) expect(problem).not.toContain(hidden);
	});

	it.each([
		["误填了带用户名和密码的地址", `https://admin:${SECRET}@proxy.internal`],
		["全角的 ＠", `admin:${SECRET}＠proxy.internal`],
		["令牌在路径里", `proxy.internal/${SECRET}`],
		["令牌在查询串里", `10.0.0.1?token=${SECRET}`],
		["地址段的其中一项带凭据", `10.0.0.0/8,admin:${SECRET}@proxy.internal`],
		["主机位置是标记", `https://${HOST_MARK}.internal:8443`],
		["像 IPv6 加网段的标记（十六进制字母、冒号、斜杠）", `dead:beef:${HOST_MARK}::/64`],
		["一串很长的、只有十六进制字符的令牌", `${"abcdef0123456789".repeat(3)}:1`],
	])("%s：说明里没有它的任何一部分，只说是第几项认不出", (_, value) => {
		const problem = oneProblem({ SFLY_TRUST_PROXY: value });

		expect(problem).toMatch(/SFLY_TRUST_PROXY 认不出：第 [12] 项/);
		expect(problem).not.toContain(SECRET);
		expect(problem).not.toContain(HOST_MARK);
		expect(problem).not.toContain("proxy.internal");
		expect(problem).not.toContain("abcdef0123456789");
		expect(problem).not.toContain("8443");
	});
});

describe("SFLY_CORS_ORIGINS、SFLY_DEV_ORIGINS", () => {
	it("合法的名单规范成浏览器发来的来源写法；没有设置或写 * 是不限制", () => {
		expect(
			readEnvSettings({
				SFLY_CORS_ORIGINS: "https://Dash.Example.com:443/x, http://localhost:5173",
			}).corsOrigins,
		).toEqual(["https://dash.example.com", "http://localhost:5173"]);
		expect(readEnvSettings({ SFLY_CORS_ORIGINS: "*" }).corsOrigins).toBeUndefined();
		expect(readEnvSettings({ SFLY_DEV_ORIGINS: "http://localhost:3000" }).sameOrigins).toEqual([
			"http://localhost:3000",
		]);
	});

	it("写错了：写明是哪个变量、第几项，不回显填的那一项；SFLY_DEV_ORIGINS 写错说的是它自己，不是 SFLY_CORS_ORIGINS", () => {
		const cors = oneProblem({ SFLY_CORS_ORIGINS: "https://ok.example.com, bad.internal" });
		expect(cors).toContain("SFLY_CORS_ORIGINS 里的第 2 项不是来源");
		expect(cors).toContain("https://dash.example.com"); // 说明里的正确写法的例子
		expect(cors).not.toContain("bad.internal");
		expect(cors).not.toContain("ok.example.com");

		const dev = oneProblem({ SFLY_DEV_ORIGINS: "localhost:3000x y" });
		expect(dev).toContain("SFLY_DEV_ORIGINS");
		expect(dev).not.toContain("SFLY_CORS_ORIGINS");
		expect(dev).not.toContain("3000x");
	});

	it.each([
		[
			"能解析的地址（协议不是 http、https），主机、端口、路径、查询串、用户名密码都有",
			`postgres://admin:${SECRET}@${HOST_MARK}.internal:5432/sfly?token=${SECRET}#${SECRET}`,
		],
		["用户名和密码、没有协议", `admin:${SECRET}@dash.example.com`],
		["全角 ＠", `https://admin:${SECRET}＠dash.example.com`],
		["令牌在路径里、没有协议", `dash.example.com/${SECRET}`],
		["令牌在查询串里、没有协议", `dash.example.com?token=${SECRET}`],
		["逗号分隔的其中一项带凭据", `https://ok.example.com,admin:${SECRET}@dash.example.com`],
		["file 地址，主机位置是标记", `file://${HOST_MARK}/share?x=1`],
		["非 http 的协议，端口位置是数字", "socket://admin:48151@host.example.com:2121/x"],
	])("名单里写错的一项（%s）：说明里没有它的任何一部分", (_, value) => {
		for (const name of ["SFLY_CORS_ORIGINS", "SFLY_DEV_ORIGINS"]) {
			const problem = oneProblem({ [name]: value });

			expect(problem).toContain(name);
			expect(problem).not.toContain(SECRET);
			expect(problem).not.toContain(HOST_MARK);
			expect(problem).not.toContain("admin");
			expect(problem).not.toContain("48151");
			expect(problem).not.toContain("2121");
			expect(problem).not.toContain("5432");
			expect(problem).not.toContain("ok.example.com");
		}
	});
});

describe("初始管理员：SFLY_ADMIN_LOGIN、SFLY_ADMIN_PASSWORD", () => {
	it("两个都给了：换成设置，显示名可选", () => {
		expect(
			readEnvSettings({
				SFLY_ADMIN_LOGIN: "root",
				SFLY_ADMIN_PASSWORD: "admin-password-1",
				SFLY_ADMIN_DISPLAY_NAME: "管理员",
			}).initialAdmin,
		).toEqual({ loginName: "root", password: "admin-password-1", displayName: "管理员" });
	});

	it("只给了一个：说明要一起设置；密码不回显", () => {
		expect(oneProblem({ SFLY_ADMIN_LOGIN: "root" })).toContain("要一起设置");
		const problem = oneProblem({ SFLY_ADMIN_PASSWORD: SECRET });
		expect(problem).toContain("要一起设置");
		expect(problem).not.toContain(SECRET);
	});

	it("登录名不合规矩、密码太短：写明哪个变量；密码不回显", () => {
		expect(oneProblem({ SFLY_ADMIN_LOGIN: "Bad Name!", SFLY_ADMIN_PASSWORD: SECRET })).toContain(
			"SFLY_ADMIN_LOGIN",
		);
		const short = oneProblem({ SFLY_ADMIN_LOGIN: "root", SFLY_ADMIN_PASSWORD: "x" });
		expect(short).toContain("SFLY_ADMIN_PASSWORD");
		expect(short).not.toContain('"x"');
		const bad = oneProblem({ SFLY_ADMIN_LOGIN: "Bad Name!", SFLY_ADMIN_PASSWORD: SECRET });
		expect(bad).not.toContain(SECRET);
	});
});

describe("SFLY_PUBLIC_URL", () => {
	it("带协议和主机的 http 或 https 地址：通过，原文去掉前后空白后交给控制面（结尾的斜杠由控制面去）", () => {
		expect(readEnvSettings({ SFLY_PUBLIC_URL: " https://sfly.example.com/ " }).publicHttpUrl).toBe(
			"https://sfly.example.com/",
		);
		expect(readEnvSettings({ SFLY_PUBLIC_URL: "http://10.0.0.5:8080" }).publicHttpUrl).toBe(
			"http://10.0.0.5:8080",
		);
		// 反向代理把控制面放在一个路径前缀下。
		expect(
			readEnvSettings({ SFLY_PUBLIC_URL: "https://corp.example.com/sfly" }).publicHttpUrl,
		).toBe("https://corp.example.com/sfly");
		expect(readEnvSettings({ SFLY_PUBLIC_URL: "http://[::1]:8080" }).publicHttpUrl).toBe(
			"http://[::1]:8080",
		);
	});

	it("少写了协议（sfly.internal:8080）：报错，不让控制面带着残缺的地址启动；不回显填的值", () => {
		const problem = oneProblem({ SFLY_PUBLIC_URL: "sfly.internal:8080" });

		expect(problem).toContain("SFLY_PUBLIC_URL");
		expect(problem).toContain("http 或 https");
		expect(problem).not.toContain("sfly.internal");
		expect(problem).not.toContain("8080");
	});

	it("协议写错（http//sfly:8080）：启动时就报错，不是 HTTP 已经开始监听之后才崩溃", () => {
		const problem = oneProblem({ SFLY_PUBLIC_URL: "http//sfly:8080" });

		expect(problem).toContain("SFLY_PUBLIC_URL");
		expect(problem).not.toContain("http//sfly");
	});

	it("写错但能解析的地址（带查询串）：说明里没有它的任何一部分，主机、端口、路径都不回显", () => {
		const problem = oneProblem({
			SFLY_PUBLIC_URL: `https://${HOST_MARK}.example.com:8443/path?x=1#top`,
		});

		expect(problem).toContain("SFLY_PUBLIC_URL");
		expect(problem).toContain("? 和 #");
		for (const part of [HOST_MARK, "8443", "/path", "x=1", "top"]) {
			expect(problem).not.toContain(part);
		}
	});

	it.each([
		["别的协议", "ftp://sfly.example.com"],
		["没有主机", "http://"],
		["只有协议", "https:"],
		["带查询串", "https://sfly.example.com/?a=1"],
		["带片段", "https://sfly.example.com/#top"],
	])("%s（%s）：报错", (_, value) => {
		expect(oneProblem({ SFLY_PUBLIC_URL: value })).toContain("SFLY_PUBLIC_URL");
	});

	it("带用户名和密码：报错，说明里没有它们（地址会写进 Agent 的配置和通知卡片的链接）", () => {
		for (const value of [
			`https://admin:${SECRET}@sfly.example.com`,
			`https://${SECRET}@sfly.example.com`,
			`http//admin:${SECRET}@sfly:8080`,
			`https://sfly.example.com/?token=${SECRET}`,
			`https://sfly.example.com/${SECRET}?x`,
			`https://admin:${SECRET}＠sfly.example.com`,
			`postgres://admin:${SECRET}@db:5432/sfly`,
		]) {
			const problem = oneProblem({ SFLY_PUBLIC_URL: value });
			expect(problem, value).toContain("SFLY_PUBLIC_URL");
			expect(problem, value).not.toContain(SECRET);
			expect(problem, value).not.toContain("admin");
		}
	});
});

describe("Agent 网关的对外地址：SFLY_PUBLIC_GRPC_URL，或者由 SFLY_PUBLIC_URL 和网关端口算出来的", () => {
	it("给了 SFLY_PUBLIC_GRPC_URL：用它", () => {
		expect(
			readEnvSettings({
				SFLY_PUBLIC_URL: "https://sfly.example.com",
				SFLY_PUBLIC_GRPC_URL: "https://grpc.example.com:443",
			}).publicGrpcUrl,
		).toBe("https://grpc.example.com:443");
	});

	it("没给：启动时就用 SFLY_PUBLIC_URL 的主机名加网关的端口算好（和控制面运行时算的一样）", () => {
		expect(
			readEnvSettings({ SFLY_PUBLIC_URL: "https://sfly.example.com/sfly", SFLY_GRPC_PORT: "50061" })
				.publicGrpcUrl,
		).toBe("http://sfly.example.com:50061");
		expect(readEnvSettings({ SFLY_PUBLIC_URL: "http://[::1]:8080" }).publicGrpcUrl).toBe(
			"http://[::1]:50051",
		);
	});

	it("网关端口填 0（让系统选）时端口要监听之后才知道：不在启动时算，留给控制面", () => {
		expect(
			readEnvSettings({ SFLY_PUBLIC_URL: "https://sfly.example.com", SFLY_GRPC_PORT: "0" })
				.publicGrpcUrl,
		).toBeUndefined();
	});

	it("没有 SFLY_PUBLIC_URL 也没有 SFLY_PUBLIC_GRPC_URL：没有可算的，留给控制面按监听地址算", () => {
		expect(readEnvSettings({}).publicGrpcUrl).toBeUndefined();
	});

	it.each([
		["sfly.internal:50051"],
		["ftp://grpc.example.com"],
		["https://grpc.example.com/some/path"],
		["https://grpc.example.com/?x=1"],
		["http://"],
	])("SFLY_PUBLIC_GRPC_URL=%s：报错", (value) => {
		expect(oneProblem({ SFLY_PUBLIC_GRPC_URL: value })).toContain("SFLY_PUBLIC_GRPC_URL");
	});

	it("SFLY_PUBLIC_GRPC_URL 带凭据：说明里没有它们", () => {
		const problem = oneProblem({ SFLY_PUBLIC_GRPC_URL: `https://u:${SECRET}@grpc.example.com` });
		expect(problem).toContain("SFLY_PUBLIC_GRPC_URL");
		expect(problem).not.toContain(SECRET);
	});

	it("SFLY_PUBLIC_URL 不合法时不再为它算网关地址：只报 SFLY_PUBLIC_URL 一条", () => {
		const problems = problemsOf({ SFLY_PUBLIC_URL: "sfly.internal:8080" });
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("SFLY_PUBLIC_URL");
	});
});

describe("DATABASE_URL", () => {
	it("什么都不写、空串、只有空白：用默认的地址（空串不再交给连接库去用 PG* 环境变量）", () => {
		for (const value of [undefined, "", "  "]) {
			expect(readEnvSettings(value === undefined ? {} : { DATABASE_URL: value }).databaseUrl).toBe(
				"postgres://sfly:sfly@127.0.0.1:5432/sfly",
			);
		}
	});

	it("TCP 的写法：通过，原样（去掉前后空白）交给控制面，不改写，也不做规范化", () => {
		for (const url of [
			"postgres://sfly:sfly@127.0.0.1:5432/sfly",
			"postgresql://u:p%40ss@db.internal/sfly?sslmode=require",
			"postgres://db/sfly",
			// 多个参数、sslmode、连接超时。
			"postgres://u:p@db.internal:6432/sfly?application_name=sfly&sslmode=verify-full&connect_timeout=5",
			// IPv6。
			"postgres://u:p@[::1]:5432/sfly",
			"postgres://u:p@[fd00::5]/sfly",
		]) {
			expect(readEnvSettings({ DATABASE_URL: ` ${url} ` }).databaseUrl, url).toBe(url);
		}
	});

	// 连接库（pg）认、以前能启动的 Unix 套接字写法：检查不能比它更严（#619 的审查：这几种被拒，升级后起不来）。
	it.each([
		["URL，主机留空、host 参数写目录", "postgres://u:p@/sfly?host=/var/run/postgresql"],
		["URL，主机写成 %2F 编码的目录", "postgres://u:p@%2Fvar%2Frun%2Fpostgresql/sfly"],
		[
			"URL，主机留空、host 参数和别的参数一起写",
			"postgres://u:p@/sfly?host=/var/run/postgresql&sslmode=disable",
		],
		["「目录 库名」", "/var/run/postgresql sfly"],
		["socket: 加目录和 db 参数", "socket:/var/run/postgresql?db=sfly"],
	])("Unix 套接字：%s（%s）通过", (_, url) => {
		expect(readEnvSettings({ DATABASE_URL: url }).databaseUrl).toBe(url);
	});

	it("连接库认不认只看连接库：它认的写法（哪怕不以 postgres:// 开头）检查都不拦，不另定前缀规则", () => {
		// 别的协议、单独一个库名、套接字的路径：连接库解析得了（别的协议照旧在连接时才失败）；检查不比它更严。
		for (const url of ["mysql://sfly:p@db/sfly", "sfly", "foo", "/var/run/postgresql sfly"]) {
			expect(readEnvSettings({ DATABASE_URL: url }).databaseUrl, url).toBe(url);
		}
	});

	// 带 `@`（用户名和密码）而没有 `://`：连接库解析得了，但不是照人写的意思用它（整串当库名、主机取默认值，第一次连库时把含密码的
	// 串当库名发给默认的主机）：启动时拒绝，固定文字，不回显。
	it.each([
		["用户:密码@主机/库名（没有协议）", `sfly:${SECRET}@db/sfly`],
		["协议的 :// 写成了 //", `postgres//sfly:${SECRET}@db/sfly`],
		["协议后面只有一个冒号", `postgres:sfly:${SECRET}@${HOST_MARK}/sfly`],
		["主机位置是标记", `sfly:p@${HOST_MARK}/sfly`],
	])("%s：报错，说明是固定的文字「没有写协议」，没有填的原文", (_, value) => {
		const problem = oneProblem({ DATABASE_URL: value });

		expect(problem).toContain("DATABASE_URL 不合法：看起来带了用户名和密码，但没有写协议");
		expect(problem).not.toContain(SECRET);
		expect(problem).not.toContain(HOST_MARK);
		expect(problem).not.toContain("sfly:");
	});

	// 连接库自己也解析不了的：照实拒。
	it.each([
		["端口不是数字", `postgres://sfly:${SECRET}@db:abc/sfly`],
		["端口超出范围", `postgres://sfly:${SECRET}@db:99999/sfly`],
		["多个主机（连接库不认）", `postgres://sfly:${SECRET}@h1:5432,h2:5432/sfly`],
		["全角的 ＠", `postgres://sfly:${SECRET}＠db/sfly`],
		// 连接库拒绝、通用的地址解析（`new URL`）却解析得了、主机位置是标记：把说明接上按地址回显的话，主机会被写出来。
		[
			"证书文件读不到（主机位置是标记）",
			`postgres://u:p@${HOST_MARK}/sfly?sslcert=/nonexistent/x.crt`,
		],
		[
			"uselibpqcompat 加 verify-ca 没给 sslrootcert（主机位置是标记）",
			`postgres://u:p@${HOST_MARK}/sfly?uselibpqcompat=true&sslmode=verify-ca`,
		],
	])("%s：报错，说明是固定的文字，没有填的原文（里面有密码）", (_, value) => {
		const problem = oneProblem({ DATABASE_URL: value });

		expect(problem).toContain("DATABASE_URL");
		expect(problem).toContain("postgres://");
		expect(problem).toContain("Unix 套接字");
		expect(problem).not.toContain(SECRET);
		expect(problem).not.toContain(HOST_MARK);
		expect(problem).not.toContain(value);
		expect(problem).not.toContain("sfly:");
	});

	it("数据库地址的任何一部分都不出现在说明里：主机、端口、库名、参数（用通用的地址解析能拆出来的每一段逐个查）", () => {
		const url = new URL(
			`postgres://usermark-r5:passmark-t6@${HOST_MARK}/dbname-q9?sslcert=/nonexistent/x.crt&app=appmark`,
		);
		const problem = oneProblem({ DATABASE_URL: url.toString() });

		for (const part of [
			url.hostname,
			url.username,
			url.password,
			"dbname-q9",
			"appmark",
			"nonexistent",
		]) {
			expect(problem, part).not.toContain(part);
		}
	});

	it("说明是固定的一句：不同的值得到同样的说明（什么都不回显，不靠「有没有 @」「能不能解析」去挑）", () => {
		const messages = new Set(
			[
				`postgres://sfly:${SECRET}@db:abc/sfly`,
				`postgres://db:abc/${SECRET}`,
				`postgres://db:${SECRET}/sfly`,
				`postgres://sfly:${SECRET}@h1:5432,h2:5432/sfly`,
				`postgres://u:p@${HOST_MARK}/sfly?sslcert=/nonexistent/x.crt`,
				"postgres://db:abc/sfly",
			].map((value) => oneProblem({ DATABASE_URL: value })),
		);

		expect(messages.size).toBe(1);
	});

	it("不带 @ 的地址写错了也不回显：数据库地址的说明里什么填的值都不写（不靠「看起来有凭据」）", () => {
		// 密码放在没有 @ 的位置（路径、库名、参数里）：说明是固定的文字，不是「有 @ 才藏」。
		const problem = oneProblem({ DATABASE_URL: `postgres://db:abc/${SECRET}?password=${SECRET}` });

		expect(problem).toContain("DATABASE_URL");
		expect(problem).not.toContain(SECRET);
		expect(problem).not.toContain("db:abc");
	});

	it("检查不吞掉连接库的一次性警告（sslmode=require）：整个进程里它只发一次，部署者看得到", async () => {
		// 新进程里跑：这条警告 pg 每个进程只发一次，在测试进程里别的用例可能已经触发过。
		const script = `
			const { databaseUrlFromEnv } = await import("./src/config/url-setting.ts");
			const pg = (await import("pg")).default;
			let warnings = 0;
			process.on("warning", (warning) => { if (warning.message.includes("SSL modes")) warnings += 1; });
			const url = databaseUrlFromEnv("postgres://u:p@db.internal/sfly?sslmode=require");
			new pg.Pool({ connectionString: url }).end();
			await new Promise((resolve) => setTimeout(resolve, 100));
			console.log("WARNINGS=" + warnings);
		`;
		const { stdout } = await run(
			process.execPath,
			["--import", "tsx", "--input-type=module", "-e", script],
			{ cwd: join(import.meta.dirname, ".."), timeout: 60_000 },
		);

		expect(stdout).toContain("WARNINGS=1");
	}, 90_000);
});

describe("镜像：SFLY_PYPI_MIRROR、SFLY_GITHUB_RELEASE_MIRROR", () => {
	it("http 或 https 地址：通过；镜像的地址可以带用户名和密码（uv 认），去掉前后空白", () => {
		expect(
			readEnvSettings({ SFLY_PYPI_MIRROR: " https://mirrors.ustc.edu.cn/pypi/simple " }).pypiMirror,
		).toBe("https://mirrors.ustc.edu.cn/pypi/simple");
		expect(
			readEnvSettings({ SFLY_GITHUB_RELEASE_MIRROR: `https://u:${SECRET}@mirror.internal/github` })
				.githubReleaseMirror,
		).toBe(`https://u:${SECRET}@mirror.internal/github`);
	});

	// uv 认 `file://` 和绝对路径做 PyPI 镜像（`--default-index`）：内网、离线的部署用共享目录。
	it.each([
		["file:// 地址", "file:///mnt/mirror/pypi/simple"],
		["file:// 地址（大写协议）", "FILE:///mnt/mirror/pypi/simple"],
		["绝对路径", "/mnt/mirror/pypi/simple"],
	])("SFLY_PYPI_MIRROR：%s通过（%s），去掉前后空白", (_, value) => {
		expect(readEnvSettings({ SFLY_PYPI_MIRROR: `  ${value}  ` }).pypiMirror).toBe(value);
	});

	// GitHub Release 镜像给 curl（装 uv 的脚本）和 uv（下载 Python）用：两者都认 `file://`；裸的绝对路径 curl 不认。
	it("SFLY_GITHUB_RELEASE_MIRROR：file:// 地址通过；裸的绝对路径不通过（curl 不认）", () => {
		expect(
			readEnvSettings({ SFLY_GITHUB_RELEASE_MIRROR: "file:///mnt/mirror/github-release" })
				.githubReleaseMirror,
		).toBe("file:///mnt/mirror/github-release");

		const problem = oneProblem({ SFLY_GITHUB_RELEASE_MIRROR: "/mnt/pathmark-v3/github-release" });
		expect(problem).toContain("SFLY_GITHUB_RELEASE_MIRROR");
		expect(problem).toContain("file://");
		expect(problem).not.toContain("绝对路径");
		expect(problem).not.toContain("pathmark-v3");
	});

	it.each([
		["SFLY_PYPI_MIRROR", "mirrors.ustc.edu.cn/pypi/simple"],
		["SFLY_PYPI_MIRROR", "ftp://mirror.internal/simple"],
		["SFLY_GITHUB_RELEASE_MIRROR", "https:/mirror.internal"],
		["SFLY_GITHUB_RELEASE_MIRROR", "http://"],
		["SFLY_GITHUB_RELEASE_MIRROR", "relative/path"],
		["SFLY_PYPI_MIRROR", "relative/path"],
	])("%s=%s：报错，写明变量名", (name, value) => {
		expect(oneProblem({ [name]: value })).toContain(name);
	});

	it("示例按变量给：GitHub Release 镜像写错时不显示 PyPI 的地址，反过来也一样", () => {
		const github = oneProblem({ SFLY_GITHUB_RELEASE_MIRROR: "mirror.internal" });
		expect(github).toContain("https://mirrors.ustc.edu.cn/github-release");
		expect(github).not.toContain("pypi");

		const pypi = oneProblem({ SFLY_PYPI_MIRROR: "mirror.internal" });
		expect(pypi).toContain("https://mirrors.ustc.edu.cn/pypi/simple");
		expect(pypi).not.toContain("github-release");
	});

	it.each([
		["用户名和密码、没有协议", `u:${SECRET}@mirror.internal/simple`],
		["全角的 ＠", `https://u:${SECRET}＠mirror.internal/simple`],
		["令牌在路径里、没有协议", `mirror.internal/${SECRET}/simple`],
		["令牌在查询串里、没有协议", `mirror.internal/simple?token=${SECRET}`],
		["协议写错、带用户名和密码", `https//u:${SECRET}@mirror.internal/simple`],
	])("写错的镜像地址带着凭据（%s）：说明里没有它们", (_, value) => {
		for (const name of ["SFLY_PYPI_MIRROR", "SFLY_GITHUB_RELEASE_MIRROR"]) {
			const problem = oneProblem({ [name]: value });
			expect(problem).toContain(name);
			expect(problem).not.toContain(SECRET);
		}
	});

	it("写错但能解析的镜像地址（协议不对）：说明里没有它的任何一部分，主机、端口、路径、用户名密码都不回显", () => {
		for (const name of ["SFLY_PYPI_MIRROR", "SFLY_GITHUB_RELEASE_MIRROR"]) {
			const problem = oneProblem({
				[name]: `ftp://u:${SECRET}@${HOST_MARK}.internal:2121/simple?x=1`,
			});

			expect(problem).toContain(name);
			for (const part of [SECRET, HOST_MARK, "2121", "x=1", "/simple?"]) {
				expect(problem, part).not.toContain(part);
			}
		}
	});
});

describe("数值类的说明里回显什么（echo.ts：像数的、不超过 12 个字符才回显）", () => {
	it.each([
		["SFLY_LOG_LIMIT_MB"],
		["SFLY_ARTIFACT_LIMIT_MB"],
		["SFLY_METRIC_LIMIT_MB"],
		["SFLY_RETENTION_DAYS"],
		["SFLY_METRIC_RETENTION_DAYS"],
		["SFLY_LOGIN_IDLE_HOURS"],
		["SFLY_HTTP_PORT"],
		["SFLY_GRPC_PORT"],
	])("%s：超过 12 个字符的数（可能是一串数字的令牌）、别的变量的值都不回显，只说有多少个字符", (name) => {
		const long = "9".repeat(13);
		const tooLong = oneProblem({ [name]: long });
		expect(tooLong).toContain(name);
		expect(tooLong).toContain("（有 13 个字符，没有回显）");
		expect(tooLong).not.toContain(long);

		const other = oneProblem({ [name]: `postgres://u:${SECRET}@db/sfly` });
		expect(other).toContain("个字符，没有回显");
		expect(other).not.toContain(SECRET);

		// 12 个字符的数照常回显。
		const twelve = oneProblem({ [name]: "999999999999" });
		expect(twelve).toContain('"999999999999"');
	});
});

describe("字符串类和数值类一起：一次报完", () => {
	const ALL_BAD = {
		SFLY_RETENTION_DAYS: "Infinity",
		SFLY_HTTP_PORT: "70000",
		SFLY_TRUST_PROXY: "banana",
		SFLY_CORS_ORIGINS: "dash.example.com",
		SFLY_ADMIN_LOGIN: "root",
		SFLY_PUBLIC_URL: "sfly.internal:8080",
		SFLY_PUBLIC_GRPC_URL: "http//grpc:50051",
		DATABASE_URL: `postgres://sfly:${SECRET}@db:abc/sfly`,
		SFLY_PYPI_MIRROR: "mirror.internal",
	};

	it("每个写错的变量一条，一条一个变量；合法的不在里面", () => {
		let caught: unknown;
		try {
			readEnvSettings({
				...ALL_BAD,
				SFLY_METRIC_RETENTION_DAYS: "30",
				SFLY_DEV_ORIGINS: "http://localhost:3000",
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(EnvSettingsError);
		const { problems, message } = caught as EnvSettingsError;
		expect(problems).toHaveLength(Object.keys(ALL_BAD).length);
		expect(message).toContain(`${problems.length} 个环境变量不合法`);
		for (const name of Object.keys(ALL_BAD)) {
			expect(
				problems.filter((p) => p.includes(name)),
				name,
			).toHaveLength(1);
		}
		expect(message).not.toContain("SFLY_METRIC_RETENTION_DAYS");
		expect(message).not.toContain("SFLY_DEV_ORIGINS");
		// 整份说明里都没有密码：不在哪一条里，也不在拼起来的总说明里。
		expect(message).not.toContain(SECRET);
	});
});
