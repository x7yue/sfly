// 助手服务协议的 HTTP 一侧：鉴权、请求的校验、健康检查、事件流的第一行。
import { join } from "node:path";
import {
	ASSISTANT_ROUTES,
	ASSISTANT_STREAM_HEARTBEAT_MS,
	AssistantHealth,
	AssistantStreamLine,
} from "@sfly/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HEARTBEAT_MS } from "../src/server.js";
import { eventually } from "./support/eventually.js";
import { EventsClient, Harness, SECRET } from "./support/harness.js";

let h: Harness;
beforeAll(async () => {
	h = await Harness.start({
		piArgv: [process.execPath, join(import.meta.dirname, "support", "fake-pi.mjs")],
	});
});
afterAll(async () => {
	await h?.close();
});

const get = (path: string, authorization?: string) =>
	fetch(`${h.url}${path}`, { headers: authorization === undefined ? {} : { authorization } });

describe("鉴权", () => {
	it("没有、错误的共享密钥：401 unauthorized，命令不执行", async () => {
		for (const authorization of [undefined, "Bearer wrong", `Bearer ${SECRET}x`, SECRET]) {
			const res = await get("/health", authorization);
			expect(res.status, String(authorization)).toBe(401);
			expect(await res.json()).toMatchObject({ code: "unauthorized" });
		}
		const id = crypto.randomUUID();
		expect((await h.prompt(id, { text: "settle" }, "wrong-secret")).status).toBe(401);
		expect(h.sessions.activeProcesses).toBe(0);
		await expect(EventsClient.connect(h.url, "wrong")).rejects.toThrow("401");
	});
});

describe("请求", () => {
	it("会话 ID 不是 UUID、请求体不对：400 invalid_request，回应里不带请求体的内容", async () => {
		const bad = await fetch(`${h.url}/sessions/../prompt`, {
			method: "POST",
			headers: { authorization: `Bearer ${SECRET}` },
		});
		expect(bad.status).toBe(404);
		const notUuid = await fetch(`${h.url}/sessions/abc/abort`, {
			method: "POST",
			headers: { authorization: `Bearer ${SECRET}` },
		});
		expect(notUuid.status).toBe(400);
		const res = await fetch(`${h.url}/sessions/${crypto.randomUUID()}/prompt`, {
			method: "POST",
			headers: { authorization: `Bearer ${SECRET}` },
			body: JSON.stringify({ turn: 0, secret_env: { T: "do-not-echo-me" } }),
		});
		expect(res.status).toBe(400);
		const text = await res.text();
		expect(JSON.parse(text)).toMatchObject({ code: "invalid_request" });
		expect(text).not.toContain("do-not-echo-me");
		// 不是 JSON 时，解析器的报错会引用请求体的一段：回应里不带它。
		const broken = await fetch(`${h.url}/sessions/${crypto.randomUUID()}/prompt`, {
			method: "POST",
			headers: { authorization: `Bearer ${SECRET}` },
			body: '{"secret_env": {"T": "do-not-echo-me"',
		});
		expect(broken.status).toBe(400);
		expect(await broken.text()).not.toContain("do-not-echo-me");
	});

	it("没有在做的一轮时停止：202，不结束什么，只记下这一轮的记号（它的 prompt 到了直接停下）", async () => {
		const before = h.sessions.abortMarks;
		expect((await h.abort(crypto.randomUUID())).status).toBe(202);
		expect(h.sessions.abortMarks).toBe(before + 1);
		expect(h.sessions.activeProcesses).toBe(0);
	});
});

describe("路由表", () => {
	it("ASSISTANT_ROUTES 里的每条都有处理（不是 404），不在表里的是 404：文档检查按这张表对照（#802）", async () => {
		const id = crypto.randomUUID();
		for (const route of ASSISTANT_ROUTES) {
			const [method, path] = route.split(" ") as [string, string];
			const abort = new AbortController();
			const res = await fetch(`${h.url}${path.replace(":id", id)}`, {
				method,
				headers: { authorization: `Bearer ${SECRET}` },
				signal: abort.signal,
			});
			expect(res.status, route).not.toBe(404);
			abort.abort();
		}
		for (const [method, path] of [
			["GET", "/sessions"],
			["POST", `/sessions/${id}/resume`],
			["DELETE", `/sessions/${id}`],
		] as const) {
			const res = await fetch(`${h.url}${path}`, {
				method,
				headers: { authorization: `Bearer ${SECRET}` },
			});
			expect(res.status, `${method} ${path}`).toBe(404);
		}
	});
});

describe("健康检查和事件流", () => {
	it("GET /health：纪元、助手服务和 pi 的版本、进程数和上限", async () => {
		const health = AssistantHealth.parse(await (await get("/health", `Bearer ${SECRET}`)).json());
		expect(health).toMatchObject({
			epoch: h.events.hello?.epoch,
			versions: { assistant: "0.0.0-test", pi: expect.stringMatching(/^\d+\.\d+\.\d+/) },
			model: { configured: true },
			processes: { active: 0, limit: 8 },
		});
	});

	it("GET /events：第一行是 hello（带纪元，没有缺口）", () => {
		expect(h.events.hello).toEqual({ type: "hello", epoch: expect.any(String), gap: false });
	});
});

describe("事件流的心跳", () => {
	it("协议的间隔是 15 秒（控制面 3 个间隔收不到任何字节就断开重连）", () => {
		expect(HEARTBEAT_MS).toBe(ASSISTANT_STREAM_HEARTBEAT_MS);
		expect(ASSISTANT_STREAM_HEARTBEAT_MS).toBe(15_000);
	});

	it("没有事件时也按间隔写心跳；有事件时照样写；断开之后不再写", async () => {
		const fast = await Harness.start({
			piArgv: [process.execPath, join(import.meta.dirname, "support", "fake-pi.mjs")],
			heartbeatMs: 40,
		});
		try {
			// 空闲：只有心跳。
			await eventually(() => expect(fast.events.heartbeats).toBeGreaterThanOrEqual(3));
			// 每一行都是协议的一行（hello、心跳或事件记录）。
			for (const line of fast.events.lines) {
				expect(() => AssistantStreamLine.parse(JSON.parse(line))).not.toThrow();
			}
			expect(fast.events.lines.filter((l) => l === '{"type":"heartbeat"}')).toHaveLength(
				fast.events.heartbeats,
			);
			// 一轮进行中照样写。
			const id = crypto.randomUUID();
			await fast.prompt(id, { text: "hang" });
			const before = fast.events.heartbeats;
			await eventually(() => expect(fast.events.heartbeats).toBeGreaterThan(before + 2));
			await fast.abort(id);
			await fast.turnEnd(id);
			// 断开之后这条连接的心跳定时器停了，也不再订阅。
			const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
			const withStream = timers();
			fast.events.close();
			await eventually(() => expect(fast.bus.subscribers).toBe(0));
			await eventually(() => expect(timers()).toBeLessThan(withStream));
		} finally {
			await fast.close();
		}
	});
});
