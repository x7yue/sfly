import { endpoint, httpContract, pathFor } from "@sfly/schema";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { guardHttpContract } from "../src/http/contract-route.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

/** 每个路径参数都填 x（`*` 也是），用来确认路由存在，不关心业务结果。 */
const samplePath = (path: string) =>
	pathFor(
		{ path },
		Object.fromEntries(
			[...path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)|\*/g)].map((m) => [m[1] ?? "*", "x"]),
		),
	);

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

	it("注册不在契约里的路由时启动失败", async () => {
		const app = Fastify();
		guardHttpContract(app, []);
		expect(() => app.get("/not-in-contract", async () => ({}))).toThrow(/不在 HTTP 契约里/);
		await app.close();
	});

	it("契约里有、控制面没有注册的接口在启动时报错", async () => {
		const app = Fastify();
		const missing = endpoint({
			method: "GET",
			path: "/missing",
			key: ["test", "missing"],
			response: z.object({}),
		});
		guardHttpContract(app, [missing]);
		await expect(app.ready()).rejects.toThrow(/GET \/missing/);
		await app.close();
	});
});
