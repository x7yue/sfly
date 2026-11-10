import { CONTROL_PLANE_TIME_EVENT, CONTROL_PLANE_TIME_HEADER } from "@sfly/schema";
import { afterEach, describe, expect, it } from "vitest";
import { ManualClock } from "./support/manual-clock.js";
import { SseClient } from "./support/sse-client.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

describe("控制面把自己的当前时间告诉页面", () => {
	let cp: TestControlPlane | undefined;
	const streams: SseClient[] = [];
	afterEach(async () => {
		for (const sse of streams.splice(0)) sse.close();
		await cp?.close();
		cp = undefined;
	});

	it("每个接口响应都带控制面时间，错误响应也带", async () => {
		const clock = new ManualClock("2025-03-07T01:02:03.000Z");
		cp = await startTestControlPlane({ clock });

		const agents = await cp.fetch("/agents");
		expect(agents.status).toBe(200);
		expect(agents.headers.get(CONTROL_PLANE_TIME_HEADER)).toBe("2025-03-07T01:02:03.000Z");

		clock.advance(90_000);
		// 浏览器经同源的 /api/* 访问。
		const viaApi = await cp.fetch("/api/runs");
		expect(viaApi.headers.get(CONTROL_PLANE_TIME_HEADER)).toBe("2025-03-07T01:03:33.000Z");

		const missing = await cp.fetch("/runs/00000000-0000-0000-0000-000000000000");
		expect(missing.status).toBe(404);
		expect(missing.headers.get(CONTROL_PLANE_TIME_HEADER)).toBe("2025-03-07T01:03:33.000Z");
	});

	it("SSE 连上时和每次心跳都推送控制面时间", async () => {
		const clock = new ManualClock("2025-03-07T01:02:03.000Z");
		cp = await startTestControlPlane({ clock, sseHeartbeatMs: 20 });
		const res = await cp.fetch("/orchestrations", {
			method: "POST",
			headers: { "content-type": "application/json", "x-sfly-nickname": "tester" },
			body: JSON.stringify({ name: "t" }),
		});
		const { id } = (await res.json()) as { id: string };

		const sse = await SseClient.open(cp, `/orchestrations/${id}/presence/events`);
		streams.push(sse);
		expect((await sse.next(CONTROL_PLANE_TIME_EVENT)).data).toEqual({
			time: "2025-03-07T01:02:03.000Z",
		});

		clock.set("2025-03-08T00:00:00.000Z");
		for (;;) {
			const { data } = await sse.next<{ time: string }>(CONTROL_PLANE_TIME_EVENT);
			if (data.time === "2025-03-08T00:00:00.000Z") break;
			expect(data.time).toBe("2025-03-07T01:02:03.000Z");
		}
	});
});
