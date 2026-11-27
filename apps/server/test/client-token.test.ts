// API 客户端的令牌（ADR 0029，#491）：初始化参数从昵称换成令牌，每个请求（含事件流）带 `Authorization: Bearer`，
// 身份由令牌决定：有令牌时不发昵称、写操作不再要昵称。没有令牌的请求控制面一律 401（#494），昵称参数之后一并删除。
import { ApiError, createClient } from "@sfly/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestAccounts } from "./support/credentials.js";
import { eventually } from "./support/eventually.js";
import { type RecordingProxy, startRecordingProxy } from "./support/recording-proxy.js";
import { seedTask } from "./support/seed-task.js";
import { startStreamingProxy } from "./support/streaming-proxy.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

describe("API 客户端带令牌", () => {
	let cp: TestControlPlane;
	let accounts: TestAccounts;
	let proxy: RecordingProxy;
	let token: string;
	let readOnlyToken: string;

	beforeAll(async () => {
		cp = await startTestControlPlane();
		accounts = new TestAccounts(cp.database.url);
		const user = await accounts.user("xiaoming", { displayName: "小明" });
		await accounts.member("default", user, "editor");
		token = await accounts.personalToken(user, { name: "我的脚本" });
		readOnlyToken = await accounts.personalToken(user, { name: "只读", scopes: ["read"] });
		proxy = await startRecordingProxy(cp.httpUrl);
	});
	afterAll(async () => {
		await proxy.close();
		await accounts.close();
		await cp.close();
	});

	const sent = () => proxy.requests.at(-1);

	it("读和写都带 Authorization: Bearer，不发昵称；写操作不需要昵称，记下的身份是令牌的用户", async () => {
		const client = createClient({ baseUrl: proxy.url, token });
		await client.system.health();
		expect(sent()?.headers.authorization).toBe(`Bearer ${token}`);
		// biome-ignore lint/plugin/test-nickname-header: 测的是 API 客户端发不发昵称请求头
		expect(sent()?.headers["x-sfly-nickname"]).toBeUndefined();
		const created = await client.request(
			{ method: "POST", path: "/projects/default/orchestrations", kind: "endpoint" },
			{ body: { name: "令牌建的场景" } },
		);
		expect(created).toMatchObject({ name: "令牌建的场景" });
		expect(sent()?.headers.authorization).toBe(`Bearer ${token}`);
		// biome-ignore lint/plugin/test-nickname-header: 测的是 API 客户端发不发昵称请求头
		expect(sent()?.headers["x-sfly-nickname"]).toBeUndefined();
	});

	it("令牌可以是每次请求时取值的函数（轮换令牌）；空白算没有", async () => {
		let current: string | undefined = token;
		const client = createClient({ baseUrl: proxy.url, token: () => current });
		await client.orchestrations.list({ params: { project: "default" } });
		expect(sent()?.headers.authorization).toBe(`Bearer ${token}`);
		current = `  ${readOnlyToken}  `;
		await client.orchestrations.list({ params: { project: "default" } });
		expect(sent()?.headers.authorization).toBe(`Bearer ${readOnlyToken}`);
		current = "   ";
		const failure = await client.orchestrations.list({ params: { project: "default" } }).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(sent()?.headers.authorization).toBeUndefined();
		// 空白的令牌等于没带凭据：控制面 401（#494）。
		expect(failure).toMatchObject({ status: 401, code: "unauthorized" });
		expect((failure as ApiError).message).toContain("sfly login");
	});

	it("事件流同样带令牌：订阅时的请求带 Authorization: Bearer，不发昵称", async () => {
		const { run } = await seedTask(cp, { agent: "agent-a", status: "running" });
		const streaming = await startStreamingProxy(cp.httpUrl);
		try {
			const client = createClient({ baseUrl: streaming.url, token });
			let opened = 0;
			const stop = client.runs.events({ params: { id: run } }, {}, { onOpen: () => opened++ });
			await eventually(() => expect(opened).toBe(1));
			stop();
			const stream = streaming.requests.find((r) => r.path === `/runs/${run}/events`);
			expect(stream?.headers.accept).toContain("text/event-stream");
			expect(stream?.headers.authorization).toBe(`Bearer ${token}`);
			// biome-ignore lint/plugin/test-nickname-header: 测的是 API 客户端发不发昵称请求头
			expect(stream?.headers["x-sfly-nickname"]).toBeUndefined();
		} finally {
			await streaming.close();
		}
	});

	it("没有令牌也没有昵称的写操作在发请求之前就抛错，说明要给令牌；读操作不受影响", async () => {
		const client = createClient({ baseUrl: proxy.url });
		const before = proxy.requests.length;
		const failure = await client
			.request(
				{ method: "POST", path: "/projects/default/orchestrations", kind: "endpoint" },
				{ body: { name: "x" } },
			)
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		expect(failure).toBeInstanceOf(ApiError);
		expect(failure).toMatchObject({ status: 400, code: "nickname_required" });
		expect((failure as ApiError).message).toContain("token");
		expect(proxy.requests.length).toBe(before);
		await client.system.health();
	});

	it("令牌失效（吊销、范围不够）：控制面的 401、403 抛成带控制面错误码的 ApiError", async () => {
		const bad = createClient({ baseUrl: proxy.url, token: "sfly_pat_not-a-real-token-0000000000" });
		const unauthorized = await bad.orchestrations.list({ params: { project: "default" } }).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(unauthorized).toMatchObject({ status: 401, code: "unauthorized" });
		const readOnly = createClient({ baseUrl: proxy.url, token: readOnlyToken });
		const forbidden = await readOnly
			.request(
				{ method: "POST", path: "/projects/default/orchestrations", kind: "endpoint" },
				{ body: { name: "x" } },
			)
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		expect(forbidden).toMatchObject({ status: 403, code: "forbidden" });
	});

	it("昵称参数还在（之后一并删除）：有令牌时令牌优先、昵称不发", async () => {
		const both = createClient({ baseUrl: proxy.url, token, nickname: "冒充的人" });
		await both.orchestrations.list({ params: { project: "default" } });
		expect(sent()?.headers.authorization).toBe(`Bearer ${token}`);
		// biome-ignore lint/plugin/test-nickname-header: 测的是 API 客户端发不发昵称请求头
		expect(sent()?.headers["x-sfly-nickname"]).toBeUndefined();
	});
});

describe("API 客户端在 http 地址上带令牌时提示", () => {
	const TOKEN = `sfly_pat_${"0123456789abcdef".repeat(3)}`;
	const okFetch = async () => Response.json([]);

	const calls = async (baseUrl: string, options: { token?: string } = { token: TOKEN }) => {
		const messages: string[] = [];
		const client = createClient({
			baseUrl,
			fetch: okFetch,
			onInsecureToken: (message) => messages.push(message),
			...options,
		});
		await client.orchestrations.list({ params: { project: "default" } });
		await client.orchestrations.list({ params: { project: "default" } });
		return messages;
	};

	it("不是本机的 http 地址：每个客户端实例提示一次，写明令牌是明文，消息里没有令牌", async () => {
		const messages = await calls("http://sfly.internal:8080");
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("http://sfly.internal:8080");
		expect(messages[0]).toContain("明文");
		expect(messages[0]).not.toContain(TOKEN);
	});

	it("本机（localhost、127.0.0.1、::1）、https、只有路径的同源地址、没有令牌：不提示", async () => {
		for (const url of [
			"http://localhost:8080",
			"http://127.0.0.1:8080",
			"http://127.1.2.3:8080",
			"http://[::1]:8080",
			"https://sfly.internal",
			"/api",
		]) {
			expect(await calls(url), url).toEqual([]);
		}
		expect(await calls("http://sfly.internal:8080", {} as { token?: string })).toEqual([]);
	});

	it("令牌是函数、第一次取到的是空：之后取到令牌的那次请求才提示", async () => {
		const messages: string[] = [];
		let current: string | undefined;
		const client = createClient({
			baseUrl: "http://sfly.internal:8080",
			fetch: okFetch,
			token: () => current,
			onInsecureToken: (message) => messages.push(message),
		});
		await client.orchestrations.list({ params: { project: "default" } });
		expect(messages).toEqual([]);
		current = TOKEN;
		await client.orchestrations.list({ params: { project: "default" } });
		expect(messages).toHaveLength(1);
	});
});
