// 控制面读的地址类环境变量（对外地址、数据库地址、镜像地址）怎么检查，以及报错时怎么写填的值（#619）。
//
// 以前这些变量原样往下传：`SFLY_PUBLIC_URL=sfly.internal:8080`（少了协议）时控制面照常启动，告诉 Agent 的网关地址是残缺的；
// 协议写错（`http//sfly:8080`）时要等 HTTP 已经开始监听才在算网关地址的 `new URL` 里崩溃，带着堆栈。现在启动时和别的环境变量
// 一起检查（env-settings.ts 的 `readEnvSettings`），写错的写明变量名、填的值和要求，一次报完。
import { isUnset } from "./decimal.js";

/**
 * 把填的值写进错误说明时怎么写：
 * - 没有 `@`、`?`、`#`：加引号原样写；
 * - 有 `?` 或 `#`：只写它们之前的部分（令牌常放在查询串里）；
 * - 有 `@`：整个都不写（`@` 前面是用户名和密码，没有办法可靠地只去掉那一段：密码里自己也可能有 `/`、`?`）。
 * 数据库地址、镜像地址、对外地址、来源名单都可能带凭据，错误说明（会进日志、容器的启动输出）里不能有它们。
 */
export function shownValue(raw: string): string {
	const text = raw.trim();
	if (text.includes("@")) return "（填的值里有 @，可能带着用户名和密码，没有回显）";
	const cut = text.search(/[?#]/);
	if (cut >= 0) return `${JSON.stringify(text.slice(0, cut))}（? 或 # 之后的部分没有回显）`;
	return JSON.stringify(text);
}

const HTTP_PREFIX = /^https?:\/\//i;

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
}

/** 地址不合要求的原因；合要求时是 undefined。 */
function httpUrlProblem(text: string, rule: HttpUrlRule): string | undefined {
	if (!HTTP_PREFIX.test(text)) {
		return "要以 http:// 或 https:// 开头（少写了协议，或者协议后面的 :// 写错了）";
	}
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return "不是合法的地址（主机或端口写错了？）";
	}
	if (url.hostname === "") return "没有主机";
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
 * 把环境变量 `name` 的原文变成 http 或 https 地址（去掉前后空白）；没设置（或空串）时是 undefined。
 * 不合要求时抛出，写明变量名、要求、不合的原因和填的值（{@link shownValue}）。
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
		throw new Error(`${name} 不合法：${rule.requirement}，${problem}，实际是 ${shownValue(text)}`);
	}
	return text;
}

/** 数据库连接串写的默认值（本机开发用）。 */
export const DEFAULT_DATABASE_URL = "postgres://sfly:sfly@127.0.0.1:5432/sfly";

/**
 * 把环境变量 `DATABASE_URL` 变成连接串（去掉前后空白）；没设置时用 {@link DEFAULT_DATABASE_URL}。
 * 只检查写法（`postgres://` 或 `postgresql://` 开头、解析得了），不连数据库。不合要求时抛出，**不回显填的值**：
 * 里面有密码。
 */
export function databaseUrlFromEnv(raw: string | undefined): string {
	if (isUnset(raw)) return DEFAULT_DATABASE_URL;
	const text = raw.trim();
	let problem: string | undefined;
	if (!/^postgres(?:ql)?:\/\//i.test(text)) {
		problem = "要以 postgres:// 或 postgresql:// 开头";
	} else if (!URL.canParse(text)) {
		problem = "不是合法的连接串（主机或端口里有不该有的字符？）";
	}
	if (problem !== undefined) {
		throw new Error(
			`DATABASE_URL 不合法：要写成 postgres://用户:密码@主机:端口/库名 这样的连接串，${problem}。没有回显填的值（里面有密码）`,
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
