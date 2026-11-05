import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { SseClient } from "./support/sse-client.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

describe("测试控制面", () => {
	let cp: TestControlPlane;
	let api: ApiClient;

	beforeAll(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
	});
	afterAll(async () => {
		await cp.close();
	});

	// 重启前留在连接池里的 keep-alive 连接（含结束的 SSE 连接）已被旧实例关闭；
	// 重启后的请求若复用它们会偶发 ECONNRESET（机器负载高时更容易出现）。
	it("重启后的请求不复用重启前的 keep-alive 连接", async () => {
		for (let i = 0; i < 30; i++) {
			const id = await api.createOrchestration(`连接-${i}`);
			const sse = await SseClient.open(cp, `/orchestrations/${id}/presence/events`);
			await sse.next("editors");
			await api.post(`/orchestrations/${id}/presence`, { session_id: "s" }, "alice");
			await sse.next("editors");

			await cp.restart();
			await expect(sse.next("editors")).rejects.toThrow(/ended/);

			const again = await SseClient.open(cp, `/orchestrations/${id}/presence/events`);
			await again.next("editors");
			again.close();
		}
	}, 60_000);
});
