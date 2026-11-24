// 错误处理只去掉「路由为文件设的头」（内容类型、长度、下载文件名、节点包归档的哈希），别的头照旧（#647）：错误响应仍然带着跨域头、
// `vary` 和登录续期的 `set-cookie`；出错的响应一律 `cache-control: no-store`。`download-read-errors.test.ts` 管「文件读不了」的那几处，
// 这里钉边界：错误处理多去掉别的头（跨域头、`set-cookie`）会让浏览器的跨域调用读不到错误、登录续期丢掉。
import { afterEach, describe, expect, it } from "vitest";
import type { ManualClock } from "./support/manual-clock.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const ORIGIN = "https://dash.example.com";
const ADMIN = { loginName: "root", password: "admin-password-1", displayName: "管理员" };

describe("错误响应上的头", () => {
	let cp: TestControlPlane | undefined;
	afterEach(async () => {
		await cp?.close();
		cp = undefined;
	});

	it("经过错误处理的错误（JSON 解析失败 400、未知路由 404）仍然带着跨域头和 vary，并且不缓存", async () => {
		cp = await startTestControlPlane({ corsOrigins: [ORIGIN] });
		const bad = await cp.fetch("/orchestrations", {
			method: "POST",
			headers: { "content-type": "application/json", origin: ORIGIN },
			body: "{",
		});
		expect(bad.status).toBe(400);
		const missing = await cp.fetch("/no/such/route", { headers: { origin: ORIGIN } });
		expect(missing.status).toBe(404);
		for (const [name, res] of [
			["400 JSON 解析失败", bad],
			["404 未知路由", missing],
		] as const) {
			expect(res.headers.get("access-control-allow-origin"), name).toBe(ORIGIN);
			expect(res.headers.get("vary"), name).toMatch(/origin/i);
			expect(res.headers.get("cache-control"), name).toBe("no-store");
			expect(res.headers.get("content-type"), name).toMatch(/^application\/json/);
		}
	});

	it("经过错误处理的错误仍然带着登录续期的 set-cookie（路由之前设好的，不是文件的头）", async () => {
		cp = await startTestControlPlane({ initialAdmin: ADMIN });
		const server = cp;
		const login = await server.fetch("/auth/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ login_name: ADMIN.loginName, password: ADMIN.password }),
		});
		expect(login.status).toBe(200);
		const cookie = /sfly_login=([^;]*)/.exec(login.headers.get("set-cookie") ?? "")?.[1] ?? "";
		// 过了续期间隔（60 秒）的请求会下发新的 Cookie；这一次请求的 JSON 解析失败（400，经过错误处理）。
		(server.clock as ManualClock).advance(61_000);
		const res = await server.fetch("/orchestrations", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				cookie: `sfly_login=${cookie}`,
				"sec-fetch-site": "same-origin",
			},
			body: "{",
		});
		expect(res.status).toBe(400);
		expect(res.headers.get("set-cookie") ?? "").toContain("sfly_login=");
		expect(res.headers.get("cache-control")).toBe("no-store");
	});

	it("不经过错误处理的错误（401）也不缓存", async () => {
		cp = await startTestControlPlane({ initialAdmin: ADMIN });
		const res = await cp.fetch("/auth/me", { headers: { "sec-fetch-site": "same-origin" } });
		expect(res.status).toBe(401);
		expect(res.headers.get("cache-control")).toBe("no-store");
	});

	it("成功的响应不受影响：没有为它设 no-store", async () => {
		cp = await startTestControlPlane();
		const res = await cp.fetch("/health");
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).not.toBe("no-store");
	});
});
