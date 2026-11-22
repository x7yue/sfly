// 跨站检查（ADR 0029「认证的几处细节」）：登录 Cookie 是浏览器自动带上的凭据，别的网页能让浏览器带着它发请求，
// 所以对带 Cookie 的请求做来源检查，检查不过就当作没有登录（不是 403：和没带 Cookie 一样处理）。
// 只检查两类：有副作用的方法（非 GET、HEAD），以及不是页面导航的跨站请求；页面导航（从飞书卡片、别的内网站点点开
// 日志或产物的下载链接）照常带着登录。不另做 CSRF 令牌；SameSite 不够用：同一个公司域名下的其他内网站点算「同站」。
//
// 判断时优先看 `Sec-Fetch-Site`：`same-origin`（页面自己发的）和 `none`（用户自己输入地址、点书签）放行。浏览器只在
// HTTPS 和 localhost 上发 `Sec-Fetch-*`，http 的内网地址上没有它，这时比较 `Origin` 和公开地址（`SFLY_PUBLIC_URL`，
// 反向代理后面是浏览器看到的地址）。没有配置公开地址时用请求的 `Host` 兜底。两个头都缺的有副作用请求当作跨站。

/** 一个请求里和来源有关的部分（都是原始的请求头）。 */
export interface BrowserRequest {
	method: string;
	fetchSite?: string | undefined;
	fetchMode?: string | undefined;
	fetchDest?: string | undefined;
	origin?: string | undefined;
	host?: string | undefined;
}

export interface OriginRules {
	/** 算同源的来源（协议://主机[:端口]，小写、没有路径）：配置的公开地址，加上开发时 vite 的地址。 */
	origins: readonly string[];
	/**
	 * 没有配置公开地址时，用请求的 `Host` 兜底：`Origin` 的主机和端口等于 `Host` 就算同源。协议不比较：
	 * 反向代理收掉 TLS 之后控制面看不到 https；cookie 不分协议，同一个主机和端口上的另一个协议不是新的口子。
	 */
	hostFallback: boolean;
}

const sideEffect = (method: string) => method !== "GET" && method !== "HEAD";

/** 页面导航：顶层的文档导航（不是 iframe、嵌入、fetch、图片、脚本）。 */
const isNavigation = ({ fetchMode, fetchDest }: BrowserRequest) =>
	fetchMode === "navigate" && fetchDest === "document";

function originAllowed(origin: string, request: BrowserRequest, rules: OriginRules): boolean {
	if (!URL.canParse(origin)) return false;
	const parsed = new URL(origin);
	if (parsed.origin === "null") return false;
	if (rules.origins.includes(parsed.origin)) return true;
	return (
		rules.hostFallback && request.host !== undefined && parsed.host === request.host.toLowerCase()
	);
}

/** 这个带 Cookie 的请求能不能用 Cookie 里的登录；false 时当作没有登录。 */
export function cookieAllowed(request: BrowserRequest, rules: OriginRules): boolean {
	const method = request.method.toUpperCase();
	const site = request.fetchSite?.toLowerCase();
	if (site !== undefined) {
		if (site === "same-origin" || site === "none") return true;
		// cross-site、same-site（同一个公司域名下的别的内网站点）和不认识的值：只有 GET、HEAD 的页面导航放行。
		return !sideEffect(method) && isNavigation(request);
	}
	if (request.origin !== undefined) return originAllowed(request.origin, request, rules);
	// 两个头都缺：有副作用的当作跨站；GET、HEAD 不是浏览器跨域的 fetch（那会带 Origin），放行。
	return !sideEffect(method);
}
