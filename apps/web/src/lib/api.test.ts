import { agentsApi, authApi, type LogChunk, logsApi } from "@sfly/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, callApi } from "./api";
import { setCurrentUser, setSessionExpiredHandler } from "./identity";
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
		const valid: LogChunk = { task_id: "t1", lines: [], offset: 0 };
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const text = [
					`event: logs\ndata: ${JSON.stringify({ task_id: 1 })}\n\n`,
					`event: logs\ndata: ${JSON.stringify(valid)}\n\n`,
				].join("");
				controller.enqueue(new TextEncoder().encode(text));
			},
		});
		vi.stubGlobal(
			"fetch",
			async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
		);
		const reported = vi.spyOn(console, "error").mockImplementation(() => {});
		const received: LogChunk[] = [];

		const close = openEventSource(
			logsApi.events,
			{ params: { id: "t1" }, query: {} },
			{ logs: (event) => received.push(event) },
		);
		await vi.waitFor(() => expect(received).toEqual([valid]));
		close();

		expect(reported).toHaveBeenCalledOnce();
	});
});

describe("请求拿到 401：登录着的人回到登录页", () => {
	const expired = vi.fn();
	const USER = { id: "u1", login_name: "root", display_name: "管理员", is_platform_admin: true };
	const unauthorized = () =>
		Response.json({ error: { code: "unauthorized", message: "凭据无效" } }, { status: 401 });
	afterEach(() => {
		setSessionExpiredHandler(undefined);
		setCurrentUser(null);
		expired.mockReset();
	});

	it("接口请求拿到 401：本来登录着就通知（请求照常以 401 失败）；没登录的不通知", async () => {
		setSessionExpiredHandler(expired);
		vi.stubGlobal("fetch", async () => unauthorized());

		setCurrentUser(null);
		await expect(callApi(agentsApi.list)).rejects.toMatchObject({ status: 401 });
		expect(expired).not.toHaveBeenCalled();

		setCurrentUser(USER);
		await expect(callApi(agentsApi.list)).rejects.toMatchObject({ status: 401 });
		expect(expired).toHaveBeenCalledTimes(1);
	});

	it("事件流重连拿到 401（登录失效之后控制面关掉了流）：同样通知，订阅随后停止", async () => {
		setSessionExpiredHandler(expired);
		setCurrentUser(USER);
		let calls = 0;
		vi.stubGlobal("fetch", async () => {
			calls++;
			return unauthorized();
		});

		const close = openEventSource(logsApi.events, { params: { id: "t1" }, query: {} }, {});
		await vi.waitFor(() => expect(expired).toHaveBeenCalledTimes(1));
		close();
		expect(calls).toBe(1);
	});

	it("登录页上登录失败的 401 不通知（还没登录）", async () => {
		setSessionExpiredHandler(expired);
		setCurrentUser(null);
		vi.stubGlobal("fetch", async () =>
			Response.json(
				{ error: { code: "invalid_credentials", message: "登录名或密码不对" } },
				{ status: 401 },
			),
		);
		await expect(
			callApi(authApi.login, { body: { login_name: "root", password: "x" } }),
		).rejects.toMatchObject({ status: 401 });
		expect(expired).not.toHaveBeenCalled();
	});
});
