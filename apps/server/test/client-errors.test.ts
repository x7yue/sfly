import { createServer } from "node:net";
import { ApiError, type Client } from "@sfly/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { observedClient, startClientControlPlane } from "./support/client.js";
import { ManualClock } from "./support/manual-clock.js";
import type { TestControlPlane } from "./support/test-control-plane.js";

async function closedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as { port: number };
	await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
	return port;
}

describe("API 客户端的错误和控制面时间", () => {
	const clock = new ManualClock("2026-01-01T00:00:00.000Z");
	let cp: TestControlPlane;
	let client: Client;
	let controlPlaneTimes: string[];

	beforeAll(async () => {
		({ cp, client, controlPlaneTimes } = await startClientControlPlane({ clock }));
	});
	afterAll(async () => {
		await cp.close();
	});

	it("控制面返回错误时抛出 ApiError，带状态、错误码、说明、方法和路径", async () => {
		const id = "00000000-0000-4000-8000-000000000000";
		const error = await client.runs.get({ params: { id } }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({
			status: 404,
			code: "not_found",
			message: expect.stringMatching(/\S/),
			method: "GET",
			path: `/runs/${id}`,
		});
	});

	it("请求不符合契约时的 ApiError 带控制面给的详情，路径含查询参数", async () => {
		const error = await client.runs.list({ query: { limit: 0 } }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({ status: 400, code: "invalid_request", path: "/runs?limit=0" });
		expect((error as ApiError).details).toEqual(
			expect.arrayContaining([expect.objectContaining({ path: ["query", "limit"] })]),
		);
	});

	it("控制面不可达时错误码是 network_error，状态为 0", async () => {
		const { client: offline } = observedClient({
			baseUrl: `http://127.0.0.1:${await closedPort()}`,
		});
		const error = await offline.system.health().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({
			status: 0,
			code: "network_error",
			method: "GET",
			path: "/health",
		});
	});

	it("调用方中止请求时抛出中止的原因，不是 ApiError", async () => {
		const reason = new Error("页面已离开");
		const controller = new AbortController();
		controller.abort(reason);
		await expect(client.system.health(undefined, { signal: controller.signal })).rejects.toBe(
			reason,
		);
	});

	it("时间回调收到每个响应带回的控制面时间，错误响应也带", async () => {
		const seen = controlPlaneTimes.length;
		await client.system.health();
		clock.advance(5_000);
		await client.dashboard.get();
		clock.advance(5_000);
		await client.runs.get({ params: { id: "missing" } }).catch(() => {});
		expect(controlPlaneTimes.slice(seen)).toEqual([
			"2026-01-01T00:00:00.000Z",
			"2026-01-01T00:00:05.000Z",
			"2026-01-01T00:00:10.000Z",
		]);
	});
});
