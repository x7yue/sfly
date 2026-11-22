import type { AuthStatus } from "@sfly/schema";

/**
 * 浏览器打开的地址和控制面认的不一致吗（ADR 0029「认证的几处细节」，PR #555 的审查）：
 *
 * 登录 Cookie 只认同源的请求。内网用 http 访问时浏览器不发 `Sec-Fetch-Site`，控制面看 `Origin`：
 * 配了公开地址（`SFLY_PUBLIC_URL`）就和它比，没配就和请求的 `Host` 比。两边对不上（主机名对 IP、端口不同，反向代理改写了
 * `Host` 又没配公开地址）时，`GET` 看起来登录着，写请求却被当作没登录：页面上什么都改不了，也登不出。
 * 不让人在这样的页面上干等：对不上就提示该用哪个地址打开。
 *
 * 开发时（vite 开发服务器）页面的地址本来就和控制面的不同，控制面用 `SFLY_DEV_ORIGINS` 认它，这里不提示（调用方判断）。
 *
 * 页面在安全上下文（https、localhost）里时不提示：浏览器只在安全上下文里发 `Sec-Fetch-Site`，控制面看到
 * `same-origin` 就放行，不再比公开地址或 `Host`。页面却总拿公开地址和 `Host` 去比，https 下用别名主机名打开、
 * 或反向代理改写了 `Host` 但走的是 https 时，请求其实一切正常，提示是误报。
 */
export type OriginProblem =
	/** 配了公开地址，浏览器用的不是它。 */
	| { kind: "public_url"; expected: string; actual: string }
	/** 没配公开地址，控制面看到的 Host 和浏览器里的不一样（多半是反向代理改写了 Host）。 */
	| { kind: "host"; seenByServer: string; actual: string };

export function originProblem(
	status: Pick<AuthStatus, "public_url" | "request_host">,
	location: { origin: string; host: string; isSecureContext: boolean },
): OriginProblem | undefined {
	if (location.isSecureContext) return undefined;
	if (status.public_url !== null) {
		const expected = URL.canParse(status.public_url)
			? new URL(status.public_url).origin
			: status.public_url;
		return expected === location.origin
			? undefined
			: { kind: "public_url", expected: status.public_url, actual: location.origin };
	}
	// 没有 Host 请求头（HTTP/1.0）时控制面也没法比，不提示。
	if (status.request_host === "" || status.request_host === location.host) return undefined;
	return { kind: "host", seenByServer: status.request_host, actual: location.host };
}

/** 提示的文字：说清楚怎么办。 */
export function originProblemText(problem: OriginProblem): string {
	if (problem.kind === "public_url") {
		return `请用 ${problem.expected} 打开：这个页面现在的地址和控制面认的公开地址不一致，登录之后的修改、登出这类操作会被当作没有登录。`;
	}
	return `控制面看到的访问地址（${problem.seenByServer}）和浏览器里的（${problem.actual}）不一致，多半是反向代理改写了 Host：让代理原样传 Host，或者在控制面设置 SFLY_PUBLIC_URL，再用那个地址打开。登录之后的修改、登出这类操作会被当作没有登录。`;
}
