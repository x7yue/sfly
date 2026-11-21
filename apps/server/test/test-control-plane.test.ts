import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { createQueuedRun } from "./support/queued-run.js";
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
		const runId = await createQueuedRun(cp);
		for (let i = 0; i < 30; i++) {
			const sse = await SseClient.open(cp, `/runs/${runId}/events`);
			await sse.next("run");
			// 一次普通请求：它的 keep-alive 连接留在连接池里。
			expect((await api.get(`/runs/${runId}`)).status).toBe(200);

			await cp.restart();
			await expect(sse.next("run")).rejects.toThrow(/ended/);

			const again = await SseClient.open(cp, `/runs/${runId}/events`);
			await again.next("run");
			again.close();
		}
	}, 60_000);
});
