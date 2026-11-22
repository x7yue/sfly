// 平台管理员的写记录带着响应的状态码：先于处理函数写下（记不上整个请求就失败，不会漏记），响应发出之后回填；
// 成功的、被拒绝的、处理函数报错的各一条。用内存里的 AccessStore 和一个手写的 Fastify 应用，处理函数想怎样就怎样。
import { feishuBotsApi } from "@sfly/schema";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccessGuard } from "../src/auth/access-guard.js";
import type { StoredUser } from "../src/auth/access-store.js";
import { hashCredential } from "../src/auth/credential-hash.js";
import { installAccessGuard } from "../src/http/access.js";
import { contractRoute } from "../src/http/contract-route.js";
import { sendError } from "../src/http/errors.js";
import { FakeAccessStore } from "./support/fake-access-store.js";
import { ManualClock } from "./support/manual-clock.js";

const ADMIN: StoredUser = {
	id: "00000000-0000-4000-8000-0000000000a1",
	displayName: "管理员",
	disabledAt: null,
	isPlatformAdmin: true,
};
const HEADERS = { authorization: "Bearer admin-token", "content-type": "application/json" };
const BODY = JSON.stringify({ name: "机器人", webhook_url: "https://open.feishu.cn/hook/a" });

describe("平台管理员的写记录：响应的状态码", () => {
	let app: FastifyInstance;
	let store: FakeAccessStore;
	let behave: (reply: Parameters<Parameters<typeof contractRoute>[2]>[1]) => unknown;

	beforeEach(async () => {
		store = new FakeAccessStore();
		store.tokens.set(hashCredential("admin-token"), {
			id: "token-1",
			kind: "personal",
			name: "运维",
			user: ADMIN,
			projectId: null,
			scopes: ["read", "run", "edit", "session_build", "publish", "manage"],
			sessionId: null,
			taskActive: null,
			expiresAt: null,
			revokedAt: null,
			lastUsedAt: null,
		});
		app = Fastify();
		installAccessGuard(app, new AccessGuard({ store, clock: new ManualClock() }));
		app.setErrorHandler((_error, _request, reply) =>
			sendError(reply, 500, "internal_error", "internal server error"),
		);
		contractRoute(app, feishuBotsApi.create, async (_request, reply) => behave(reply) as never);
		await app.ready();
	});
	afterEach(async () => {
		await app.close();
	});

	const post = () =>
		app.inject({ method: "POST", url: "/feishu-bots", headers: HEADERS, payload: BODY });
	const statuses = () => store.adminResults.map((r) => r.status);

	it("成功的：201", async () => {
		behave = (reply) => reply.code(201).send({});
		expect((await post()).statusCode).toBe(201);
		await expect.poll(statuses).toEqual([201]);
		expect(store.adminWrites).toHaveLength(1);
	});

	it("被拒绝的（处理函数返回 409）：记录还在，状态码是 409", async () => {
		behave = (reply) => sendError(reply, 409, "conflict", "重名");
		expect((await post()).statusCode).toBe(409);
		await expect.poll(statuses).toEqual([409]);
	});

	it("处理函数报错：500 也留下一条，状态码是 500", async () => {
		behave = () => {
			throw new Error("炸了");
		};
		expect((await post()).statusCode).toBe(500);
		await expect.poll(statuses).toEqual([500]);
		expect(store.adminWrites).toHaveLength(1);
	});

	it("回填状态码失败（库没了）：响应照常，记录留着、状态码为空（结果未知），应用没有挂", async () => {
		behave = (reply) => reply.code(201).send({});
		store.completeAdminWrite = async () => {
			throw new Error("库没了");
		};
		const first = await post();
		expect(first.statusCode).toBe(201);
		// 响应已经发出，回填失败只记日志；之后的请求照常处理。
		await expect.poll(() => store.adminWrites.length).toBe(1);
		expect((await post()).statusCode).toBe(201);
		await expect.poll(() => store.adminWrites.length).toBe(2);
		expect(store.adminResults).toEqual([]);
	});

	it("记不上记录，整个请求就失败，处理函数不会被调用（不漏记）", async () => {
		let called = false;
		behave = (reply) => {
			called = true;
			return reply.code(201).send({});
		};
		store.recordAdminWrite = async () => {
			throw new Error("库写不进去");
		};
		expect((await post()).statusCode).toBe(500);
		expect(called).toBe(false);
	});

	it("读操作和他是成员时本来就有权限的写，不记录，也就没有状态码要回填", async () => {
		behave = (reply) => reply.code(201).send({});
		store.setRole("default", ADMIN, "project_admin");
		expect((await post()).statusCode).toBe(201);
		expect(store.adminWrites).toEqual([]);
		expect(store.adminResults).toEqual([]);
	});
});
