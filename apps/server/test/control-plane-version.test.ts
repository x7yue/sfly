import { CONTROL_PLANE_VERSION_HEADER } from "@sfly/schema";
import { afterEach, describe, expect, it } from "vitest";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

describe("控制面在响应上带自己的版本号", () => {
	let cp: TestControlPlane | undefined;
	afterEach(async () => {
		await cp?.close();
		cp = undefined;
	});

	it("每个接口响应都带版本号，错误响应和 /api 前缀的响应也带", async () => {
		cp = await startTestControlPlane({ version: "7.8.9" });

		const agents = await cp.fetch("/agents");
		expect(agents.status).toBe(200);
		expect(agents.headers.get(CONTROL_PLANE_VERSION_HEADER)).toBe("7.8.9");

		const viaApi = await cp.fetch("/api/runs");
		expect(viaApi.headers.get(CONTROL_PLANE_VERSION_HEADER)).toBe("7.8.9");

		const missing = await cp.fetch("/runs/00000000-0000-0000-0000-000000000000");
		expect(missing.status).toBe(404);
		expect(missing.headers.get(CONTROL_PLANE_VERSION_HEADER)).toBe("7.8.9");

		const unknown = await cp.fetch("/no-such-route");
		expect(unknown.status).toBe(404);
		expect(unknown.headers.get(CONTROL_PLANE_VERSION_HEADER)).toBe("7.8.9");
	});

	it("SSE 流的响应头也带版本号", async () => {
		cp = await startTestControlPlane({ version: "7.8.9" });
		const created = await cp.fetch("/orchestrations", {
			method: "POST",
			headers: { "content-type": "application/json", "x-sfly-nickname": "tester" },
			body: JSON.stringify({ name: "t" }),
		});
		const { id } = (await created.json()) as { id: string };

		const abort = new AbortController();
		const stream = await cp.fetch(`/orchestrations/${id}/presence/events`, {
			headers: { accept: "text/event-stream" },
			signal: abort.signal,
		});
		expect(stream.status).toBe(200);
		expect(stream.headers.get("content-type")).toMatch(/^text\/event-stream/);
		expect(stream.headers.get(CONTROL_PLANE_VERSION_HEADER)).toBe("7.8.9");
		abort.abort();
	});

	it("默认是控制面包的版本号", async () => {
		cp = await startTestControlPlane();
		const res = await cp.fetch("/health");
		expect(res.headers.get(CONTROL_PLANE_VERSION_HEADER)).toBe(cp.version);
	});
});
