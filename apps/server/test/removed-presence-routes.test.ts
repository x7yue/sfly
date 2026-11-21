// 在线编辑者（编辑页面的心跳、离开、名单推送）已移除（#445、ADR 0028）：它只存在于控制面内存里，没有存量数据。
// 升级时还开着的旧页面会继续发心跳和离开请求、重连名单推送：这三个路径现在是普通的 404（和别的未知路由一样），
// 不报错，也不影响同一个控制面上别的请求。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

describe("已移除的在线编辑者接口", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let id: string;

	beforeAll(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		id = await api.createOrchestration("旧页面还开着的场景");
	});
	afterAll(async () => {
		await cp.close();
	});

	it("心跳、离开、名单推送三个路径都是普通的 404，别的请求不受影响", async () => {
		const requests = [
			// 旧页面的请求原样：带昵称、带会话 ID（直接请求和浏览器走的 /api 前缀各一遍）
			["POST", `/orchestrations/${id}/presence`],
			["POST", `/api/orchestrations/${id}/presence`],
			["POST", `/orchestrations/${id}/presence/leave`],
			["POST", `/api/orchestrations/${id}/presence/leave`],
			["GET", `/orchestrations/${id}/presence/events`],
			["GET", `/api/orchestrations/${id}/presence/events`],
		] as const;
		for (const [method, path] of requests) {
			const res =
				method === "POST"
					? await api.post(path, { session_id: "旧页面的会话" }, "alice")
					: await cp.fetch(path, { headers: { accept: "text/event-stream" } });
			expect(res.status, `${method} ${path}`).toBe(404);
			expect(res.headers.get("content-type"), `${method} ${path}`).toMatch(/^application\/json/);
			// 控制面把 /api 前缀去掉之后再找路由，所以错误信息里是不带前缀的路径
			const routed = path.replace(/^\/api(?=\/)/, "");
			expect(await res.json(), `${method} ${path}`).toEqual({
				error: { code: "not_found", message: `route ${method} ${routed} not found` },
			});
		}

		// 场景不存在、没有昵称、请求体不对也一样：路径没了，走不到原来的校验
		expect((await cp.fetch(`/orchestrations/${id}/presence`, { method: "POST" })).status).toBe(404);
		const missing = "00000000-0000-0000-0000-000000000000";
		expect((await api.post(`/orchestrations/${missing}/presence/leave`, {})).status).toBe(404);
		expect((await cp.fetch(`/orchestrations/${missing}/presence/events`)).status).toBe(404);

		// 同一个场景和控制面上别的请求照常
		expect((await api.get("/health")).status).toBe(200);
		expect((await api.get(`/orchestrations/${id}`)).status).toBe(200);
		expect(await api.createOrchestration("之后新建的场景")).toMatch(/^[0-9a-f-]{36}$/);
	});
});
