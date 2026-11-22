// API 客户端的令牌（ADR 0029，#491）：初始化参数从昵称换成令牌，每个请求（含事件流）带 `Authorization: Bearer`，
// 身份由令牌决定：有令牌时不发昵称、写操作不再要昵称。昵称参数保留给控制台（没登录的人 #494 之前仍用昵称）。
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
		expect(sent()?.headers["x-sfly-nickname"]).toBeUndefined();
		const created = await client.request(
			{ method: "POST", path: "/orchestrations", kind: "endpoint" },
			{ body: { name: "令牌建的场景" } },
		);
		expect(created).toMatchObject({ name: "令牌建的场景" });
		expect(sent()?.headers.authorization).toBe(`Bearer ${token}`);
		expect(sent()?.headers["x-sfly-nickname"]).toBeUndefined();
	});

	it("令牌可以是每次请求时取值的函数（轮换令牌）；空白算没有", async () => {
		let current: string | undefined = token;
		const client = createClient({ baseUrl: proxy.url, token: () => current });
		await client.orchestrations.list();
		expect(sent()?.headers.authorization).toBe(`Bearer ${token}`);
		current = `  ${readOnlyToken}  `;
		await client.orchestrations.list();
		expect(sent()?.headers.authorization).toBe(`Bearer ${readOnlyToken}`);
		current = "   ";
		await client.orchestrations.list();
		expect(sent()?.headers.authorization).toBeUndefined();
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
				{ method: "POST", path: "/orchestrations", kind: "endpoint" },
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
		const unauthorized = await bad.orchestrations.list().then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(unauthorized).toMatchObject({ status: 401, code: "unauthorized" });
		const readOnly = createClient({ baseUrl: proxy.url, token: readOnlyToken });
		const forbidden = await readOnly
			.request(
				{ method: "POST", path: "/orchestrations", kind: "endpoint" },
				{ body: { name: "x" } },
			)
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		expect(forbidden).toMatchObject({ status: 403, code: "forbidden" });
	});

	it("昵称参数还在（控制台没登录的人 #494 之前用它）：有令牌时令牌优先、昵称不发", async () => {
		const both = createClient({ baseUrl: proxy.url, token, nickname: "冒充的人" });
		await both.orchestrations.list();
		expect(sent()?.headers.authorization).toBe(`Bearer ${token}`);
		expect(sent()?.headers["x-sfly-nickname"]).toBeUndefined();
		const onlyNickname = createClient({ baseUrl: proxy.url, nickname: "小红" });
		await onlyNickname.orchestrations.list();
		expect(sent()?.headers.authorization).toBeUndefined();
		expect(sent()?.headers["x-sfly-nickname"]).toBe(encodeURIComponent("小红"));
	});
});
