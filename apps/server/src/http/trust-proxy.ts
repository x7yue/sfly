// `SFLY_TRUST_PROXY` 怎么变成 Fastify 的 `trustProxy`：登录限速用的「来源地址」从哪里取。
//
// 反向代理通常把它看到的客户端地址**追加**在 `X-Forwarded-For` 的最后，客户端自己带来的值留在前面：
// `X-Forwarded-For: <客户端自己写的>, <代理看到的真实地址>`。所以来源地址要取「可信代理之前的那一个」（从右往左数，
// 跳过可信代理，第一个不可信的），不能取最左边的一段：最左边的是客户端自己写的，每次换一个就绕过按地址的限速。
//
// 两种写法：
// - 地址段（推荐）：`127.0.0.1,10.0.0.0/8`，逗号分隔的 IP 或 CIDR（也认 `loopback`、`linklocal`、`uniquelocal`）。
//   连接控制面的对端在段里，才信它带来的 `X-Forwarded-For`，并且从右往左跳过段里的地址；直连的客户端不在段里，
//   它写什么都不作数。
// - 层数：`1`（也可以写 `true`）表示前面有一层代理，`2` 两层：不管对端是谁，跳过右边的这几个地址。Fastify 的 `trustProxy`
//   数字写法在 5.12 起不再按层数用（它没法验证直接连上来的对端，直连的客户端能伪造），所以这里自己写成函数。
//   用层数时控制面的端口只能经代理访问（防火墙、只监听内网地址），否则直连的客户端能伪造来源地址；有固定的代理地址就用地址段。
import { isIP } from "node:net";
import type { FastifyServerOptions } from "fastify";
import { echoNumber } from "../config/echo.js";

/** 认得的关键字（Fastify / proxy-addr 认的几个名字）。 */
const PROXY_KEYWORDS: ReadonlySet<string> = new Set(["loopback", "linklocal", "uniquelocal"]);

/** 层数的上限：再多就是写错了。 */
const MAX_HOPS = 10;

/** 一个 IP 或 CIDR（`10.0.0.0/8`、`fd00::/8`）或关键字合不合规矩。 */
function validEntry(entry: string): boolean {
	if (PROXY_KEYWORDS.has(entry.toLowerCase())) return true;
	const [address = "", prefix, ...rest] = entry.split("/");
	const version = isIP(address);
	if (version === 0 || rest.length > 0) return false;
	if (prefix === undefined) return true;
	return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (version === 4 ? 32 : 128);
}

/**
 * 解析环境变量：没设置、空、`false`、`0` 是不信任；`true` 和数字是层数；其余是逗号分隔的地址段，写错了抛错
 * （启动时就失败，不悄悄退回到不信任或者全信任）。
 */
export function parseTrustProxy(value: string | undefined): FastifyServerOptions["trustProxy"] {
	const text = (value ?? "").trim();
	const lower = text.toLowerCase();
	if (text === "" || lower === "false" || text === "0") return false;
	if (lower === "true") return hops(1);
	if (/^\d+$/.test(text)) {
		const count = Number(text);
		if (count > MAX_HOPS) {
			throw new Error(
				`SFLY_TRUST_PROXY 不合法：代理的层数不会超过 ${MAX_HOPS}，实际是 ${echoNumber(text)}，是不是写错了`,
			);
		}
		return hops(count);
	}
	const entries = text.split(",").map((entry) => entry.trim());
	// 认不出的项只说是第几项，**不回显填的那一项**：误把带用户名和密码的地址填进这个变量时，凭据不进启动输出和日志
	// （echo.ts：只有数值类的回显）。
	const bad = entries.flatMap((entry, index) => (validEntry(entry) ? [] : [`第 ${index + 1} 项`]));
	if (bad.length > 0) {
		throw new Error(
			`SFLY_TRUST_PROXY 认不出：${bad.join("、")}不是 IP（10.0.0.1）、网段（10.0.0.0/8）或 loopback、linklocal、uniquelocal。写代理的层数（1），或者逗号分隔的代理地址段（127.0.0.1,10.0.0.0/8）`,
		);
	}
	return entries.join(",");
}

/** 信任右边的 `count` 个地址（0 号是连接控制面的对端）：Fastify 取到第一个不可信的地址，就是客户端。 */
const hops =
	(count: number) =>
	(_address: string, hop: number): boolean =>
		hop < count;
