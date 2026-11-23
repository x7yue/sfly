// 控制面读的字符串类环境变量也在启动时和数值类的一起检查（#619，接 #577）：代理信任、跨域来源、初始管理员、对外地址、
// 数据库地址、镜像地址。写错了的都收进同一条 EnvSettingsError，一次报完；退出码 1、不打印堆栈（main.ts 接住它，见
// main-env-settings.test.ts）。报错里不出现密码、密钥和地址里的凭据：这里每个会带保密内容的变量都填一个带记号的值，
// 断言记号不在说明里。
import { describe, expect, it } from "vitest";
import { EnvSettingsError, readEnvSettings } from "../src/config/env-settings.js";

/** 会出现在密码、地址里的凭据位置的记号：说明里不能有它（哪怕是一部分）。 */
const SECRET = "Hunter2-secret-9f3a";

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
		["banana", "banana"],
		["11", "11"],
		["10.0.0.0/33", "10.0.0.0/33"],
		["10.0.0.0/8,oops", "oops"],
	])("写错了（%s）：报变量名和填的原文，不是带堆栈的未捕获错误", (value, shown) => {
		const problem = oneProblem({ SFLY_TRUST_PROXY: value });

		expect(problem).toContain("SFLY_TRUST_PROXY");
		expect(problem).toContain(shown);
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

	it("写错了：写明是哪个变量；SFLY_DEV_ORIGINS 写错说的是它自己，不是 SFLY_CORS_ORIGINS", () => {
		const cors = oneProblem({ SFLY_CORS_ORIGINS: "dash.example.com" });
		expect(cors).toContain("SFLY_CORS_ORIGINS");
		expect(cors).toContain('"dash.example.com"');

		const dev = oneProblem({ SFLY_DEV_ORIGINS: "localhost:3000x y" });
		expect(dev).toContain("SFLY_DEV_ORIGINS");
		expect(dev).not.toContain("SFLY_CORS_ORIGINS");
	});

	it("名单里写错的一项带着用户名和密码：说明里没有它们", () => {
		// 没有协议、有 @：浏览器的来源不带用户名和密码，这一项本来就写错了。
		const problem = oneProblem({ SFLY_CORS_ORIGINS: `admin:${SECRET}@dash.example.com` });

		expect(problem).toContain("SFLY_CORS_ORIGINS");
		expect(problem).not.toContain(SECRET);
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

	it("少写了协议（sfly.internal:8080）：报错，不让控制面带着残缺的地址启动", () => {
		const problem = oneProblem({ SFLY_PUBLIC_URL: "sfly.internal:8080" });

		expect(problem).toContain("SFLY_PUBLIC_URL");
		expect(problem).toContain('"sfly.internal:8080"');
		expect(problem).toContain("http 或 https");
	});

	it("协议写错（http//sfly:8080）：启动时就报错，不是 HTTP 已经开始监听之后才崩溃", () => {
		const problem = oneProblem({ SFLY_PUBLIC_URL: "http//sfly:8080" });

		expect(problem).toContain("SFLY_PUBLIC_URL");
		expect(problem).toContain('"http//sfly:8080"');
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
		]) {
			const problem = oneProblem({ SFLY_PUBLIC_URL: value });
			expect(problem, value).toContain("SFLY_PUBLIC_URL");
			expect(problem, value).not.toContain(SECRET);
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
	it("postgres:// 或 postgresql:// 开头的地址：通过，原样交给控制面（不改写，也不做规范化）", () => {
		for (const url of [
			"postgres://sfly:sfly@127.0.0.1:5432/sfly",
			"postgresql://u:p%40ss@db.internal/sfly?sslmode=require",
			"postgres://db/sfly",
		]) {
			expect(readEnvSettings({ DATABASE_URL: url }).databaseUrl, url).toBe(url);
		}
	});

	it.each([
		["没写协议", `sfly:${SECRET}@db/sfly`],
		["协议写错了", `postgres//sfly:${SECRET}@db/sfly`],
		["别的协议", `mysql://sfly:${SECRET}@db/sfly`],
		["端口不是数字", `postgres://sfly:${SECRET}@db:abc/sfly`],
		["主机里有空格", `postgres://sfly:${SECRET}@db host/sfly`],
	])("%s：报错，说明里没有填的原文（里面有密码）", (_, value) => {
		const problem = oneProblem({ DATABASE_URL: value });

		expect(problem).toContain("DATABASE_URL");
		expect(problem).not.toContain(SECRET);
		expect(problem).not.toContain(value);
		expect(problem).toContain("postgres://");
	});
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

	it.each([
		["SFLY_PYPI_MIRROR", "mirrors.ustc.edu.cn/pypi/simple"],
		["SFLY_PYPI_MIRROR", "ftp://mirror.internal/simple"],
		["SFLY_GITHUB_RELEASE_MIRROR", "https:/mirror.internal"],
		["SFLY_GITHUB_RELEASE_MIRROR", "http://"],
	])("%s=%s：报错，写明变量名", (name, value) => {
		expect(oneProblem({ [name]: value })).toContain(name);
	});

	it("写错的镜像地址带着用户名和密码：说明里没有它们", () => {
		const problem = oneProblem({ SFLY_PYPI_MIRROR: `u:${SECRET}@mirror.internal/simple` });
		expect(problem).toContain("SFLY_PYPI_MIRROR");
		expect(problem).not.toContain(SECRET);
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
		DATABASE_URL: `postgres//sfly:${SECRET}@db/sfly`,
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
