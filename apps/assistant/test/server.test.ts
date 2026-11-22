// 助手服务协议的 HTTP 一侧：鉴权、请求的校验、健康检查、事件流的第一行。
import { join } from "node:path";
import { AssistantHealth } from "@sfly/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
	});

	it("没有在做的一轮时停止：202，什么都不做", async () => {
		expect((await h.abort(crypto.randomUUID())).status).toBe(202);
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
