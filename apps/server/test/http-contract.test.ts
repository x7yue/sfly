import { DECLARATION_RULES, endpoint, httpContract } from "@sfly/schema";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { AccessGuard } from "../src/auth/access-guard.js";
import { installAccessGuard } from "../src/http/access.js";
import { contractRoute, guardHttpContract } from "../src/http/contract-route.js";
import { FakeAccessStore } from "./support/fake-access-store.js";
import { ManualClock } from "./support/manual-clock.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

/** 每个路径参数都填 x（`*` 也是），用来确认路由存在，不关心业务结果。 */
const samplePath = (path: string) => path.replace(/:[A-Za-z_][A-Za-z0-9_]*|\*$/g, "x");

describe("HTTP 契约覆盖控制面的全部路由", () => {
	let cp: TestControlPlane;
	beforeAll(async () => {
		cp = await startTestControlPlane();
	});
	afterAll(async () => {
		await cp.close();
	});

	it("契约里的每个接口在控制面上都有路由", async () => {
		for (const def of httpContract) {
			const res = await cp.fetch(samplePath(def.path), {
				method: def.method,
				headers: { accept: "application/json" },
			});
			const body = await res.text();
			// 没注册的路由由 Fastify 的 notFound 处理：404 `route <方法> <路径> not found`。
			expect(body, `${def.method} ${def.path}`).not.toMatch(/"message":"route /);
		}
	});

	it("响应里的时间字段（time、*_at、*_time）都用 Timestamp（契约约定 2）", () => {
		const plain: string[] = [];
		const seen = new Set<unknown>();
		const walk = (schema: unknown, path: string) => {
			if (!schema || typeof schema !== "object" || seen.has(schema)) return;
			seen.add(schema);
			const def = (schema as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
			if (!def) return;
			const field = path.split(".").at(-1) ?? "";
			if (def.type === "string" && /^(time|.*_at|.*_time)$/.test(field) && !def.format) {
				plain.push(path);
			}
			if (def.shape) {
				for (const [k, v] of Object.entries(def.shape as Record<string, unknown>)) {
					walk(v, `${path}.${k}`);
				}
			}
			for (const key of ["element", "innerType", "valueType", "in", "out"]) walk(def[key], path);
			for (const option of (def.options as unknown[] | undefined) ?? []) walk(option, path);
		};
		for (const def of httpContract) {
			if ("response" in def) walk(def.response, `${def.method} ${def.path}`);
			if ("events" in def) {
				for (const [name, schema] of Object.entries(def.events))
					walk(schema, `${def.path} ${name}`);
			}
		}
		expect(plain).toEqual([]);
	});

	it("注册不在契约里的路由时启动失败", async () => {
		const app = Fastify();
		guardHttpContract(app, []);
		expect(() => app.get("/not-in-contract", async () => ({}))).toThrow(/不在 HTTP 契约里/);
		await app.close();
	});

	it("手写一个契约里有的路径（没经 contractRoute）时启动失败：它没有访问检查，不能靠测试才发现", async () => {
		const app = Fastify();
		const health = endpoint({
			method: "GET",
			path: "/health",
			summary: "测试用的接口",
			effect: "read",
			resource: { kind: "system", target: "global" },
			client: false,
			key: ["test", "health"],
			response: z.object({}),
		});
		guardHttpContract(app, [health]);
		expect(() => app.get("/health", async () => ({}))).toThrow(/不是经 contractRoute/);
		await app.close();
	});

	it("手写的 HEAD 也不行：先于契约里的 GET 注册的 HEAD 会顶掉 Fastify 自动生成的那个，没有访问检查，启动要失败", async () => {
		const app = Fastify();
		const health = endpoint({
			method: "GET",
			path: "/health",
			summary: "测试用的接口",
			effect: "read",
			resource: { kind: "system", target: "global" },
			client: false,
			key: ["test", "health"],
			response: z.object({}),
		});
		guardHttpContract(app, [health]);
		installAccessGuard(
			app,
			new AccessGuard({ store: new FakeAccessStore(), clock: new ManualClock() }),
		);
		expect(() => app.head("/health", async () => ({}))).toThrow(/不是经 contractRoute/);
		await app.close();
	});

	it("经 contractRoute 注册的 GET 自动生成的 HEAD 带着标记，照常通过", async () => {
		const app = Fastify();
		const health = endpoint({
			method: "GET",
			path: "/health",
			summary: "测试用的接口",
			effect: "read",
			resource: { kind: "system", target: "global" },
			client: false,
			key: ["test", "health"],
			response: z.object({}),
		});
		guardHttpContract(app, [health]);
		installAccessGuard(
			app,
			new AccessGuard({ store: new FakeAccessStore(), clock: new ManualClock() }),
		);
		contractRoute(app, health, async () => ({}));
		await app.ready();
		expect((await app.inject({ method: "HEAD", url: "/health" })).statusCode).toBe(200);
		await app.close();
	});

	it("经 contractRoute、contractStream、contractDownload 注册的路由照常通过", async () => {
		const app = Fastify();
		const health = endpoint({
			method: "GET",
			path: "/health",
			summary: "测试用的接口",
			effect: "read",
			resource: { kind: "system", target: "global" },
			client: false,
			key: ["test", "health"],
			response: z.object({}),
		});
		guardHttpContract(app, [health]);
		installAccessGuard(
			app,
			new AccessGuard({ store: new FakeAccessStore(), clock: new ManualClock() }),
		);
		expect(() => contractRoute(app, health, async () => ({}))).not.toThrow();
		await app.ready();
		await app.close();
	});

	it("契约里有、控制面没有注册的接口在启动时报错", async () => {
		const app = Fastify();
		const missing = endpoint({
			method: "GET",
			path: "/missing",
			summary: "测试用的接口",
			effect: "read",
			resource: { kind: "system", target: "global" },
			client: false,
			key: ["test", "missing"],
			response: z.object({}),
		});
		// 这个测试用的路径不在 PATH_KINDS 里：把它当成平台自身的接口登记，只检查「没有注册路由」这一条。
		const rules = {
			...DECLARATION_RULES,
			pathKinds: {
				...DECLARATION_RULES.pathKinds,
				"/missing": { kind: "system", exact: true, why: "测试用" },
			},
		} as const;
		guardHttpContract(app, [missing], rules);
		await expect(app.ready()).rejects.toThrow(/GET \/missing/);
		await app.close();
	});
});

describe("请求里的 NUL 字符（#212）", () => {
	let cp: TestControlPlane;
	beforeAll(async () => {
		cp = await startTestControlPlane();
	});
	afterAll(async () => {
		await cp.close();
	});

	it("路径参数含 NUL 的标识不指向任何东西，返回 404 not_found", async () => {
		for (const [method, path] of [
			["POST", "/agents/%00/update-now"],
			["GET", "/packages/stub/versions/%00"],
		] as const) {
			const res = await cp.fetch(path, { method });
			expect(res.status, `${method} ${path}`).toBe(404);
			expect(await res.json(), `${method} ${path}`).toMatchObject({ error: { code: "not_found" } });
		}
	});

	it("查询参数与 JSON 请求体里含 NUL 的字符串返回 400 invalid_request", async () => {
		const create = await cp.fetch("/orchestrations", {
			method: "POST",
			headers: { "content-type": "application/json", "x-sfly-nickname": "alice" },
			body: JSON.stringify({ name: "a\u0000b" }),
		});
		expect(create.status).toBe(400);
		expect(await create.json()).toMatchObject({ error: { code: "invalid_request" } });

		const list = await cp.fetch("/orchestrations?q=%00", {
			headers: { "x-sfly-nickname": "alice" },
		});
		expect(list.status).toBe(400);
		expect(await list.json()).toMatchObject({ error: { code: "invalid_request" } });
	});
});
