// 跨站检查（ADR 0029「认证的几处细节」）：只对带 Cookie 的请求，只看两类：有副作用的方法（非 GET、HEAD），
// 以及不是页面导航的跨站请求。检查不过就当作没有登录。优先看 Sec-Fetch-Site，没有它时比较 Origin 和公开地址。
import { describe, expect, it } from "vitest";
import { type BrowserRequest, cookieAllowed } from "../src/auth/cross-site.js";

const PUBLIC = ["https://sfly.example.com"];
const allow = (request: Partial<BrowserRequest> & { method: string }, allowed = PUBLIC) =>
	cookieAllowed({ ...request }, { origins: allowed, hostFallback: false });

describe("有 Sec-Fetch-Site 时只看它（现代浏览器，HTTPS 或 localhost）", () => {
	it("同源和用户自己输入地址（none）放行：写请求也是", () => {
		for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]) {
			expect(allow({ method, fetchSite: "same-origin" }), method).toBe(true);
			expect(allow({ method, fetchSite: "none" }), method).toBe(true);
		}
	});

	it("有副作用的请求：cross-site 和 same-site 都不放行（同一个公司域名下的别的内网站点算同站）", () => {
		for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
			expect(allow({ method, fetchSite: "cross-site" }), method).toBe(false);
			expect(allow({ method, fetchSite: "same-site" }), method).toBe(false);
		}
	});

	it("有副作用的请求就算是导航（表单提交）也不放行", () => {
		expect(
			allow({
				method: "POST",
				fetchSite: "cross-site",
				fetchMode: "navigate",
				fetchDest: "document",
			}),
		).toBe(false);
	});

	it("跨站的页面导航 GET（飞书卡片、别的内网站点点开日志或产物的链接）带着登录照常放行", () => {
		for (const fetchSite of ["cross-site", "same-site"]) {
			expect(
				allow({ method: "GET", fetchSite, fetchMode: "navigate", fetchDest: "document" }),
				fetchSite,
			).toBe(true);
		}
	});

	it("跨站但不是页面导航的 GET 不放行：fetch、图片、脚本、嵌在 iframe 里的导航", () => {
		for (const [mode, dest] of [
			["cors", "empty"],
			["no-cors", "image"],
			["no-cors", "script"],
			["navigate", "iframe"],
			["navigate", "embed"],
			[undefined, undefined],
		]) {
			expect(
				allow({ method: "GET", fetchSite: "cross-site", fetchMode: mode, fetchDest: dest }),
				`${mode}/${dest}`,
			).toBe(false);
		}
	});

	it("有 Sec-Fetch-Site 时不再看 Origin：同源的请求 Origin 写什么都放行，跨站的 Origin 写成公开地址也不放行", () => {
		expect(
			allow({ method: "POST", fetchSite: "same-origin", origin: "https://evil.example" }),
		).toBe(true);
		expect(allow({ method: "POST", fetchSite: "cross-site", origin: PUBLIC[0] })).toBe(false);
	});

	it("不认识的 Sec-Fetch-Site 值按跨站处理", () => {
		expect(allow({ method: "POST", fetchSite: "weird" })).toBe(false);
	});
});

describe("没有 Sec-Fetch-Site（浏览器在 http 的内网地址上不发它）时看 Origin", () => {
	it("Origin 是公开地址：写请求放行；是别的地址、null、写不成来源的，不放行", () => {
		expect(allow({ method: "POST", origin: "https://sfly.example.com" })).toBe(true);
		for (const origin of [
			"https://evil.example",
			"http://sfly.example.com",
			"https://sfly.example.com:8443",
			"https://sfly.example.com.evil.example",
			"null",
			"not a url",
		]) {
			expect(allow({ method: "POST", origin }), origin).toBe(false);
		}
	});

	it("两个头都缺的有副作用请求当作跨站", () => {
		for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
			expect(allow({ method }), method).toBe(false);
		}
	});

	it("GET、HEAD 两个头都缺放行（curl、旧浏览器的导航）；带了别的来源的 Origin 就是跨站的 fetch，不放行", () => {
		expect(allow({ method: "GET" })).toBe(true);
		expect(allow({ method: "HEAD" })).toBe(true);
		expect(allow({ method: "GET", origin: "https://evil.example" })).toBe(false);
		expect(allow({ method: "GET", origin: PUBLIC[0] })).toBe(true);
	});

	it("开发时 vite 的地址也算同源：多给的来源和公开地址一样放行", () => {
		const origins = [...PUBLIC, "http://localhost:3000"];
		expect(allow({ method: "POST", origin: "http://localhost:3000" }, origins)).toBe(true);
		expect(allow({ method: "POST", origin: "http://localhost:3001" }, origins)).toBe(false);
	});
});

describe("没有配置公开地址（SFLY_PUBLIC_URL）时用请求的 Host 兜底", () => {
	const fallback = (request: Partial<BrowserRequest> & { method: string }) =>
		cookieAllowed(request, { origins: [], hostFallback: true });

	it("Origin 的主机和端口等于 Host：放行（协议不比，反向代理收掉 TLS 之后控制面看不到 https）", () => {
		expect(
			fallback({ method: "POST", origin: "http://10.1.2.3:8080", host: "10.1.2.3:8080" }),
		).toBe(true);
		expect(fallback({ method: "POST", origin: "https://sfly.corp", host: "sfly.corp" })).toBe(true);
	});

	it("同一台主机的别的端口、别的主机名都不放行（cookie 不分端口，另一个端口上的服务不能借它登录）", () => {
		expect(
			fallback({ method: "POST", origin: "http://10.1.2.3:9090", host: "10.1.2.3:8080" }),
		).toBe(false);
		expect(fallback({ method: "POST", origin: "http://evil.example", host: "10.1.2.3:8080" })).toBe(
			false,
		);
		expect(fallback({ method: "POST", origin: "http://10.1.2.3:8080" })).toBe(false);
	});

	it("配了公开地址时不用 Host：浏览器看到的地址以配置为准", () => {
		expect(
			cookieAllowed(
				{ method: "POST", origin: "http://10.1.2.3:8080", host: "10.1.2.3:8080" },
				{ origins: PUBLIC, hostFallback: false },
			),
		).toBe(false);
	});
});
