import { describe, expect, it } from "vitest";
import { originProblem, originProblemText } from "./origin";

const at = (url: string, isSecureContext = false) => ({
	origin: new URL(url).origin,
	host: new URL(url).host,
	isSecureContext,
});

describe("浏览器打开的地址和控制面认的一致吗", () => {
	it("配了公开地址：地址一样（含端口、协议）没有问题；主机名对 IP、端口不同、协议不同都是问题，写明该用哪个", () => {
		const status = { public_url: "http://sfly.corp:8080", request_host: "sfly.corp:8080" };
		expect(originProblem(status, at("http://sfly.corp:8080/runs"))).toBeUndefined();
		for (const url of [
			"http://10.1.2.3:8080/",
			"http://sfly.corp:9090/",
			"https://sfly.corp:8080/",
		]) {
			const problem = originProblem(status, at(url));
			expect(problem, url).toEqual({
				kind: "public_url",
				expected: "http://sfly.corp:8080",
				actual: new URL(url).origin,
			});
			expect(originProblemText(problem as NonNullable<typeof problem>)).toContain(
				"请用 http://sfly.corp:8080 打开：",
			);
		}
	});

	it("没配公开地址：控制面看到的 Host 和浏览器里的一样没有问题；不一样（代理改写了 Host）是问题，说明怎么办", () => {
		const status = { public_url: null, request_host: "10.0.0.5:8080" };
		expect(originProblem(status, at("http://10.0.0.5:8080/"))).toBeUndefined();
		const problem = originProblem(status, at("http://sfly.corp/"));
		expect(problem).toEqual({ kind: "host", seenByServer: "10.0.0.5:8080", actual: "sfly.corp" });
		const text = originProblemText(problem as NonNullable<typeof problem>);
		expect(text).toContain("10.0.0.5:8080");
		expect(text).toContain("sfly.corp");
		expect(text).toContain("SFLY_PUBLIC_URL");
	});

	it("控制面没有看到 Host：没法比，不提示", () => {
		expect(
			originProblem({ public_url: null, request_host: "" }, at("http://a:1/")),
		).toBeUndefined();
	});

	it("公开地址写得不是合法的 URL：原样当作期望的来源去比（不抛错）", () => {
		expect(
			originProblem({ public_url: "sfly-corp", request_host: "x" }, at("http://sfly.corp/")),
		).toMatchObject({ kind: "public_url", expected: "sfly-corp" });
	});

	// 控制面看到 `Sec-Fetch-Site: same-origin` 就放行，不再比公开地址或 Host；浏览器只在安全上下文（https、localhost）里发这个头。
	// 页面在安全上下文里时，请求一定带着它，提示就是误报。
	it("安全上下文（https、localhost）里不提示：浏览器会发 Sec-Fetch-Site，控制面据此放行，不比公开地址和 Host", () => {
		// https 下用别名主机名打开：公开地址对不上，但控制面看到的是 same-origin。
		expect(
			originProblem(
				{ public_url: "https://sfly.corp", request_host: "sfly.corp" },
				at("https://sfly-alias.corp/", true),
			),
		).toBeUndefined();
		// 反向代理改写了 Host、走 https：Host 对不上，也不提示。
		expect(
			originProblem(
				{ public_url: null, request_host: "10.0.0.5:8080" },
				at("https://sfly.corp/", true),
			),
		).toBeUndefined();
		// localhost（安全上下文，http）一样。
		expect(
			originProblem(
				{ public_url: "http://sfly.corp:8080", request_host: "sfly.corp:8080" },
				at("http://localhost:8080/", true),
			),
		).toBeUndefined();
	});

	it("不是安全上下文（http 加 IP 或主机名）：照旧比对，对不上就提示", () => {
		expect(
			originProblem(
				{ public_url: "http://sfly.corp:8080", request_host: "sfly.corp:8080" },
				at("http://10.1.2.3:8080/", false),
			),
		).toMatchObject({ kind: "public_url" });
		expect(
			originProblem(
				{ public_url: null, request_host: "10.0.0.5:8080" },
				at("http://sfly.corp/", false),
			),
		).toMatchObject({ kind: "host" });
	});
});
