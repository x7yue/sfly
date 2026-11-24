// 控制面读的地址类环境变量（对外地址、数据库地址、镜像地址）怎么检查（#619）。报错里不回显填的值（echo.ts：只有数值类的回显）：写变量名、哪里不对和一个例子。
//
// 以前这些变量原样往下传：`SFLY_PUBLIC_URL=sfly.internal:8080`（少了协议）时控制面照常启动，告诉 Agent 的网关地址是残缺的；
// 协议写错（`http//sfly:8080`）时要等 HTTP 已经开始监听才在算网关地址的 `new URL` 里崩溃，带着堆栈。现在启动时和别的环境变量
// 一起检查（env-settings.ts 的 `readEnvSettings`），写错的写明变量名和要求（不回显填的值），一次报完。
import pg from "pg";
import { isUnset } from "./decimal.js";

const HTTP_PREFIX = /^https?:\/\//i;
const FILE_PREFIX = /^file:\/\//i;

/** 地址类设置的写法要求。 */
export interface HttpUrlRule {
	/** 写在说明开头的要求，例如「要写成带协议和主机的 http 或 https 地址（例如 https://sfly.example.com）」。 */
	readonly requirement: string;
	/**
	 * true：不能带用户名和密码、`?`、`#`（对外地址会写进 Agent 的配置、通知卡片的链接，拼上路径用的）；
	 * false：这些都可以（镜像地址可以带用户名和密码，uv 认）。
	 */
	readonly strict: boolean;
	/** true：不能带路径（Agent 网关的地址是一个主机加端口）。 */
	readonly noPath?: boolean;
	/** true：也认 `file://` 地址（本地目录当镜像，内网、离线的部署用共享目录，uv 认）。 */
	readonly allowFile?: boolean;
	/** true：也认绝对路径（`/mnt/mirror/pypi/simple`，uv 的 `--default-index` 认）。 */
	readonly allowAbsolutePath?: boolean;
}

/** 地址不合要求的原因；合要求时是 undefined。 */
function httpUrlProblem(text: string, rule: HttpUrlRule): string | undefined {
	if (rule.allowAbsolutePath && text.startsWith("/")) return undefined;
	const file = rule.allowFile === true && FILE_PREFIX.test(text);
	if (!HTTP_PREFIX.test(text) && !file) {
		const all = [
			"http://",
			"https://",
			...(rule.allowFile ? ["file://"] : []),
			...(rule.allowAbsolutePath ? ["绝对路径"] : []),
		];
		const last = all.pop();
		return `要以 ${all.join("、")} 或 ${last} 开头（少写了协议，或者协议后面的 :// 写错了）`;
	}
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return "不是合法的地址（主机或端口写错了？）";
	}
	if (file) return undefined;
	if (rule.strict) {
		if (url.username !== "" || url.password !== "" || text.includes("@")) {
			return "不能带用户名和密码";
		}
		if (text.includes("?") || text.includes("#")) return "不能带 ? 或 # 之后的部分";
	}
	if (rule.noPath && url.pathname !== "" && url.pathname !== "/") return "不能带路径";
	return undefined;
}

/**
 * 把环境变量 `name` 的原文变成地址（去掉前后空白）；没设置（或空串）时是 undefined。
 * 不合要求时抛出，写明变量名、要求（带一个正确写法的例子）和不合的原因；**不回显填的值**（里面可能是别的变量的值，带着凭据）。
 */
export function httpUrlFromEnv(
	name: string,
	raw: string | undefined,
	rule: HttpUrlRule,
): string | undefined {
	if (isUnset(raw)) return undefined;
	const text = raw.trim();
	const problem = httpUrlProblem(text, rule);
	if (problem !== undefined) {
		throw new Error(`${name} 不合法：${rule.requirement}，${problem}`);
	}
	return text;
}

/** 数据库连接串写的默认值（本机开发用）。 */
export const DEFAULT_DATABASE_URL = "postgres://sfly:sfly@127.0.0.1:5432/sfly";

/**
 * 连接库（pg）认不认这个连接串：用它自己解析连接串的那个函数（`new pg.Client` 构造时就解析，不连接）。**检查不能比真正用这个值的
 * 一方更严**：pg 认的写法（Unix 套接字的三种：`postgres://用户:密码@/库名?host=/var/run/postgresql`、`/var/run/postgresql 库名`、
 * `socket:/var/run/postgresql?db=库名`，多个参数、`sslmode`……）都过，它也解析不了的才拒。
 * 解析时 pg 会读 `sslcert`、`sslkey`、`sslrootcert` 指的文件（连接时它读的是同一回事：读不到就是解析不了），为 `sslmode=require`
 * 之类发一条一次性的警告（它自己只发一次，这里不去压它：压掉等于吞掉部署者唯一会看到的那条安全提醒）。
 */
function pgParses(connectionString: string): boolean {
	try {
		new pg.Client({ connectionString });
		return true;
	} catch {
		return false;
	}
}

/**
 * 把环境变量 `DATABASE_URL` 变成连接串（去掉前后空白）；没设置（或空串，和别的变量一个规矩）时用 {@link DEFAULT_DATABASE_URL}。
 * 只检查 pg 解析得了（{@link pgParses}），不连数据库。不合要求时抛出，**不回显填的值**：里面有密码，说明是固定的文字。
 * 控制面和 `reset-password` 子命令读它用的是同一个函数。
 */
export function databaseUrlFromEnv(raw: string | undefined): string {
	if (isUnset(raw)) return DEFAULT_DATABASE_URL;
	const text = raw.trim();
	// 带 `@`（用户名和密码）而没有 `://`：连接库解析得了，但不是照人写的意思用它：把整串当成库名、主机取默认值，第一次连库时把这串
	// （含密码）当库名发给那台默认的主机。不比连接库严：它用不了这种写法。别的没有 `://` 的写法（套接字的路径、单独一个库名）照旧放行。
	if (text.includes("@") && !text.includes("://")) {
		throw new Error(
			"DATABASE_URL 不合法：看起来带了用户名和密码，但没有写协议（要写成 postgres://用户:密码@主机:端口/库名）。没有回显填的值（里面有密码）",
		);
	}
	if (!pgParses(text)) {
		throw new Error(
			"DATABASE_URL 不合法：连接库（pg）解析不了这个连接串。写成 postgres://用户:密码@主机:端口/库名；走 Unix 套接字写成 postgres://用户:密码@/库名?host=/var/run/postgresql；主机、端口里不能有不该有的字符，也不能写多个主机；sslcert、sslkey、sslrootcert 指的文件要读得到，uselibpqcompat=true 加 sslmode=verify-ca 要同时给 sslrootcert。没有回显填的值（里面有密码）",
		);
	}
	return text;
}

/**
 * Agent 网关（gRPC）的对外地址：和对外地址（HTTP）同一个主机、另一个端口的 http 地址。
 * 控制面没有配置 `SFLY_PUBLIC_GRPC_URL` 时用它；启动时（端口已知的话）和监听之后（端口是系统选的）都用这一个。
 */
export function gatewayUrlFrom(publicHttpUrl: string, port: number | string): string {
	return `http://${new URL(publicHttpUrl).hostname}:${port}`;
}
