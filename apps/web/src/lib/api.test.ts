import { agentsApi, type EditorsEvent, presenceApi } from "@sfly/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, callApi } from "./api";
import { openEventSource } from "./sse";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("开发环境下按契约校验响应", () => {
	it("响应不符合契约时抛出 contract_violation 的 ApiError（页面显示为错误状态），details 是 zod issues", async () => {
		vi.stubGlobal("fetch", async () =>
			Response.json({ agents: "不是列表", control_plane_version: "0.3.0" }),
		);

		const error = await callApi(agentsApi.list).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({
			status: 200,
			code: "contract_violation",
			method: "GET",
			path: "/agents",
			details: [expect.objectContaining({ path: ["agents"] })],
		});
	});

	it("符合契约时返回响应体", async () => {
		const body = { agents: [], control_plane_version: "0.3.0" };
		vi.stubGlobal("fetch", async () => Response.json(body));

		await expect(callApi(agentsApi.list)).resolves.toEqual(body);
	});

	it("事件不符合契约时在控制台报错并丢弃，符合的照常分发", async () => {
		const valid: EditorsEvent = { orchestration_id: "o1", editors: [] };
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const text = [
					`event: editors\ndata: ${JSON.stringify({ orchestration_id: 1 })}\n\n`,
					`event: editors\ndata: ${JSON.stringify(valid)}\n\n`,
				].join("");
				controller.enqueue(new TextEncoder().encode(text));
			},
		});
		vi.stubGlobal(
			"fetch",
			async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
		);
		const reported = vi.spyOn(console, "error").mockImplementation(() => {});
		const received: EditorsEvent[] = [];

		const close = openEventSource(
			presenceApi.events,
			{ params: { id: "o1" } },
			{ editors: (event) => received.push(event) },
		);
		await vi.waitFor(() => expect(received).toEqual([valid]));
		close();

		expect(reported).toHaveBeenCalledOnce();
	});
});
