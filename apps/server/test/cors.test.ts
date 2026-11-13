import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { parseCorsOrigins } from "../src/http/cors.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const PAGE = "https://dash.example.com";
const OTHER_PAGE = "https://evil.example.net";
const REQUEST_HEADERS = "content-type, x-sfly-nickname, x-sfly-client";
const NAVIGATE = { accept: "text/html,application/xhtml+xml,*/*;q=0.8" };
const JSON_HEADERS = { "content-type": "application/json", "x-sfly-nickname": "tester" };

const tokens = (res: Response, name: string) =>
	(res.headers.get(name) ?? "")
		.split(",")
		.map((token) => token.trim())
		.filter(Boolean);

const headerNames = (res: Response, name: string) =>
	tokens(res, name).map((token) => token.toLowerCase());

function preflight(
	cp: TestControlPlane,
	path: string,
	{ origin = PAGE, method = "POST", headers = REQUEST_HEADERS } = {},
) {
	return cp.fetch(path, {
		method: "OPTIONS",
		headers: {
			origin,
			"access-control-request-method": method,
			"access-control-request-headers": headers,
		},
	});
}

async function openPresenceStream(cp: TestControlPlane, origin: string) {
	const created = await cp.fetch("/orchestrations", {
		method: "POST",
		headers: JSON_HEADERS,
		body: JSON.stringify({ name: "t" }),
	});
	const { id } = (await created.json()) as { id: string };
	const abort = new AbortController();
	const stream = await cp.fetch(`/orchestrations/${id}/presence/events`, {
		headers: { accept: "text/event-stream", origin },
		signal: abort.signal,
	});
	expect(stream.status).toBe(200);
	abort.abort();
	return stream;
}

describe("跨域：默认允许所有来源", () => {
	let cp: TestControlPlane | undefined;
	afterEach(async () => {
		await cp?.close();
		cp = undefined;
	});

	it.each([
		["根路径", "/orchestrations/any/runs"],
		["/api 前缀", "/api/orchestrations/any/runs"],
	])("预检（%s）：204，允许所有来源、写方法、客户端的请求头，带缓存时间，不带凭据", async (_name, path) => {
		cp = await startTestControlPlane();

		const res = await preflight(cp, path);

		expect(res.status).toBe(204);
		expect(await res.text()).toBe("");
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
		expect(headerNames(res, "access-control-allow-headers")).toEqual(
			expect.arrayContaining(["content-type", "x-sfly-nickname", "x-sfly-client", "last-event-id"]),
		);
		expect(Number(res.headers.get("access-control-max-age"))).toBeGreaterThan(0);
		expect(res.headers.get("access-control-allow-credentials")).toBeNull();
	});

	it.each(["GET", "POST", "PUT", "PATCH", "DELETE"])("预检允许 %s", async (method) => {
		cp = await startTestControlPlane();

		const res = await preflight(cp, "/orchestrations/any", { method });

		expect(res.status).toBe(204);
		expect(tokens(res, "access-control-allow-methods")).toContain(method);
	});

	it("不是预检的 OPTIONS（没有 Origin 或没有 Access-Control-Request-Method）照常处理", async () => {
		cp = await startTestControlPlane();

		const plain = await cp.fetch("/agents", { method: "OPTIONS" });
		const noMethod = await cp.fetch("/agents", { method: "OPTIONS", headers: { origin: PAGE } });

		expect(plain.status).toBe(404);
		expect(noMethod.status).toBe(404);
	});

	it("接口响应带允许来源和暴露的响应头：成功、错误、/api 前缀、未知路由都一样", async () => {
		cp = await startTestControlPlane();
		const responses = await Promise.all([
			cp.fetch("/agents", { headers: { origin: PAGE } }),
			cp.fetch("/api/runs", { headers: { origin: PAGE } }),
			cp.fetch("/orchestrations", {
				method: "POST",
				headers: { "content-type": "application/json", origin: PAGE },
				body: JSON.stringify({ name: "t" }),
			}),
			cp.fetch("/no-such-route", { headers: { origin: PAGE } }),
		]);

		expect(responses.map((res) => res.status)).toEqual([200, 200, 400, 404]);
		for (const res of responses) {
			expect(res.headers.get("access-control-allow-origin")).toBe("*");
			expect(headerNames(res, "access-control-expose-headers")).toEqual(
				expect.arrayContaining(["x-sfly-version", "x-sfly-time"]),
			);
			expect(res.headers.get("access-control-allow-credentials")).toBeNull();
			expect(res.headers.get("vary")).toBeNull();
		}
	});

	it("事件流（SSE）的响应头也带允许来源和暴露的响应头", async () => {
		cp = await startTestControlPlane();

		const stream = await openPresenceStream(cp, PAGE);

		expect(stream.headers.get("content-type")).toMatch(/^text\/event-stream/);
		expect(stream.headers.get("access-control-allow-origin")).toBe("*");
		expect(headerNames(stream, "access-control-expose-headers")).toEqual(
			expect.arrayContaining(["x-sfly-version", "x-sfly-time"]),
		);
		expect(stream.headers.get("x-sfly-version")).toBe(cp.version);
	});
});

describe("跨域：控制台的静态文件不带跨域头", () => {
	let webDir: string;
	let cp: TestControlPlane | undefined;
	beforeAll(async () => {
		webDir = await mkdtemp(join(tmpdir(), "sfly-cors-web-"));
		await mkdir(join(webDir, "assets"));
		await writeFile(join(webDir, "index.html"), "<!doctype html><div id=app></div>");
		await writeFile(join(webDir, "assets", "app-abc123.js"), "console.log('sfly');");
	});
	afterAll(async () => {
		await rm(webDir, { recursive: true, force: true });
	});
	afterEach(async () => {
		await cp?.close();
		cp = undefined;
	});

	it.each([
		["默认", undefined],
		["名单", [PAGE]],
	])("入口页和静态资源没有跨域头，同一来源的接口有（%s）", async (_name, corsOrigins) => {
		cp = await startTestControlPlane({ webDir, corsOrigins });

		const index = await cp.fetch("/", { headers: { ...NAVIGATE, origin: PAGE } });
		const asset = await cp.fetch("/assets/app-abc123.js", { headers: { origin: PAGE } });
		const api = await cp.fetch("/api/agents", { headers: { origin: PAGE } });

		expect(index.status).toBe(200);
		expect(asset.status).toBe(200);
		for (const res of [index, asset]) {
			expect(res.headers.get("access-control-allow-origin")).toBeNull();
			expect(res.headers.get("access-control-expose-headers")).toBeNull();
		}
		expect(api.headers.get("access-control-allow-origin")).not.toBeNull();
	});
});

describe("跨域：来源名单", () => {
	let cp: TestControlPlane | undefined;
	afterEach(async () => {
		await cp?.close();
		cp = undefined;
	});

	it("名单里的来源：预检、接口响应和事件流都按来源回应，并带 Vary: Origin", async () => {
		cp = await startTestControlPlane({ corsOrigins: [PAGE, "http://localhost:5173"] });

		const answered = await preflight(cp, "/api/orchestrations/any/runs");
		const agents = await cp.fetch("/agents", { headers: { origin: "http://localhost:5173" } });
		const stream = await openPresenceStream(cp, PAGE);

		expect(answered.status).toBe(204);
		expect(answered.headers.get("access-control-allow-origin")).toBe(PAGE);
		expect(headerNames(answered, "access-control-allow-headers")).toEqual(
			expect.arrayContaining(["content-type", "x-sfly-nickname", "x-sfly-client", "last-event-id"]),
		);
		expect(Number(answered.headers.get("access-control-max-age"))).toBeGreaterThan(0);
		expect(agents.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
		expect(stream.headers.get("access-control-allow-origin")).toBe(PAGE);
		for (const res of [answered, agents, stream]) {
			expect(headerNames(res, "vary")).toContain("origin");
			expect(headerNames(res, "access-control-expose-headers")).toEqual(
				expect.arrayContaining(["x-sfly-version", "x-sfly-time"]),
			);
		}
	});

	it("名单外的来源：预检、接口响应和事件流都不带允许来源，浏览器会拦下", async () => {
		cp = await startTestControlPlane({ corsOrigins: [PAGE] });

		const refused = await preflight(cp, "/orchestrations/any/runs", { origin: OTHER_PAGE });
		const agents = await cp.fetch("/agents", { headers: { origin: OTHER_PAGE } });
		const stream = await openPresenceStream(cp, OTHER_PAGE);

		expect(agents.status).toBe(200);
		for (const res of [refused, agents, stream]) {
			expect(res.headers.get("access-control-allow-origin")).toBeNull();
			expect(res.headers.get("access-control-allow-methods")).toBeNull();
			expect(headerNames(res, "vary")).toContain("origin");
		}
	});

	it("名单只比较来源：端口或协议不同的页面不算在名单里", async () => {
		cp = await startTestControlPlane({ corsOrigins: ["http://localhost:5173"] });

		const wrongPort = await cp.fetch("/agents", { headers: { origin: "http://localhost:5174" } });
		const wrongScheme = await cp.fetch("/agents", {
			headers: { origin: "https://localhost:5173" },
		});

		expect(wrongPort.headers.get("access-control-allow-origin")).toBeNull();
		expect(wrongScheme.headers.get("access-control-allow-origin")).toBeNull();
	});

	it("没有 Origin 的请求（命令行、Agent、同源页面）不带允许来源", async () => {
		cp = await startTestControlPlane({ corsOrigins: [PAGE] });

		const res = await cp.fetch("/agents");

		expect(res.status).toBe(200);
		expect(res.headers.get("access-control-allow-origin")).toBeNull();
	});
});

describe("SFLY_CORS_ORIGINS 的解析", () => {
	it.each([
		undefined,
		"",
		"  ",
		" , ,",
		"*",
		"https://dash.example.com, *",
	])("%j：不收窄，允许所有来源", (raw) => {
		expect(parseCorsOrigins(raw)).toBeUndefined();
	});

	it("逗号分隔，去掉空白和空项，规范成浏览器发来的来源写法", () => {
		expect(
			parseCorsOrigins(
				" https://Dash.example.com/ , http://localhost:5173,, https://x.example.com:443/app?a=1 ",
			),
		).toEqual(["https://dash.example.com", "http://localhost:5173", "https://x.example.com"]);
	});

	it.each([
		"dash.example.com",
		"https://a.example.com, not a url",
		"file:///tmp/page.html",
	])("%j：不是来源，启动时报错并指出这一项", (raw) => {
		expect(() => parseCorsOrigins(raw)).toThrow(/SFLY_CORS_ORIGINS/);
	});
});
