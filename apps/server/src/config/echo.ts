// 环境变量写错时，报错说明里回显什么（#619）：**所有**环境变量的报错回显填的值，都只经过这一个文件里的函数，
// 而且是「认得的才回显」：不是「看起来像凭据的不回显」（全角的 `＠`、凭据放在路径里、放在 `proxy` 的某一项里……
// 总有认不出的形状），而是只有确认是无害的写法才写出来，其余一律不写，只说是哪个变量（第几项）、要什么写法。
//
// 报错会进启动输出和容器日志（`docker compose logs`），谁都看得到；填错的变量里常常是别的变量的值（把带密码的数据库地址
// 填进了对外地址，把带用户名密码的地址填进了代理信任）。
//
// - 地址类（对外地址、网关地址、镜像、跨域和开发来源的每一项）：能解析、协议是认得的（http、https、file……）时只回显
//   协议、主机和端口，路径、查询串、片段、用户名和密码一律不回显；解析不了、协议不认得的不回显。
// - 数字类（端口、保留天数、各种上限、登录的空闲期限）：只有像一个数（带不带单位后缀）、或者认得的几个词
//   （`Infinity`、`NaN`）才回显。
// - 代理信任的每一项：只由 IP、网段用得到的字符组成、或者是认得的关键字才回显。
// - 数据库地址、管理员密码：一律不回显（不经过这里，说明里是固定的文字）。
// 回显的值带引号（JSON 写法），没回显的是一句说明，用「（…）」括起来。

/** 回显的地址里认得的协议：写错的地址（`user:密码@主机` 被解析成协议 `user:`）不会把用户名当协议写出来。 */
const KNOWN_PROTOCOLS = /^(?:https?|file|ftps?|wss?|postgres(?:ql)?|socket):$/i;

/** 没回显时写的说明。 */
export const NOT_ECHOED = {
	unparseable: "（解析不了，没有回显）",
	protocol: "（协议不是认得的 http、https、file 等，没有回显）",
	path: "（一个路径，没有回显）",
	unknown: "（认不出，没有回显）",
} as const;

/** 地址类的值回显成什么：协议加主机和端口（`"https://host:8443"`）；解析不了、协议不认得、是路径的写说明。 */
export function echoUrl(raw: string): string {
	const text = raw.trim();
	if (text.startsWith("/")) return NOT_ECHOED.path;
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return NOT_ECHOED.unparseable;
	}
	if (!KNOWN_PROTOCOLS.test(url.protocol)) return NOT_ECHOED.protocol;
	return JSON.stringify(`${url.protocol}//${url.host}`);
}

/** 像一个数：只由写数用得到的字符（数字、`.`、`,`、`_`、正负号、`e`、空格）组成，后面可以跟一个短的单位后缀（`10MB`、`30 天`）；或者十六进制。 */
const NUMBER_LIKE = /^[\d.,_+\-eE ]+[A-Za-z%天小时分钟秒]{0,6}$|^[+-]?0[xX][0-9a-fA-F]+$/;
/** 认得的几个词。 */
const NUMBER_WORDS = /^[+-]?(?:infinity|inf|nan)$/i;

/** 数字类的值回显成什么：像一个数、或者认得的词才回显原文（带引号），否则写说明。 */
export function echoNumber(raw: string): string {
	const text = raw.trim();
	if (text.length <= 32 && (NUMBER_LIKE.test(text) || NUMBER_WORDS.test(text))) {
		return JSON.stringify(raw);
	}
	return NOT_ECHOED.unknown;
}

/** `SFLY_TRUST_PROXY` 里认得的关键字。 */
export const PROXY_KEYWORDS: ReadonlySet<string> = new Set([
	"loopback",
	"linklocal",
	"uniquelocal",
]);

/**
 * 代理信任的一项回显成什么：只由 IP、网段用得到的字符（数字、十六进制字母、`:`、`.`、`/`）组成、而且至少有一个 `.`、`:` 或 `/`
 * （一串只有十六进制字母和数字的令牌不是地址的样子），或者是认得的关键字。
 */
export function echoProxyItem(raw: string): string {
	const text = raw.trim();
	if (
		text.length <= 64 &&
		((/^[0-9A-Fa-f:./]+$/.test(text) && /[.:/]/.test(text)) ||
			PROXY_KEYWORDS.has(text.toLowerCase()))
	) {
		return JSON.stringify(text);
	}
	return NOT_ECHOED.unknown;
}
