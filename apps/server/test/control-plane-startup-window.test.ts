// 控制面启动的那几毫秒：HTTP 在 `startAgentGateway` 之前就开始监听了（路由登记完、监听上才去起网关），助手服务的事件连接在网关起来之后才建。
// 这段时间里进来的请求（列出会话的就绪状态、建会话）会问「事件流连着没有」：连接对象还没建好时当作没连上，回 503，
// 不能是「引用还没初始化」的 ReferenceError → 500（#764 复审）。
// 用现有的入口造这个窗口：把 `startAgentGateway` 换成一个等放行才继续的版本（产品代码不为测试改任何接口），HTTP 已经监听上、网关还没起来时发请求。
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionListResponse } from "@sfly/schema";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { TestUsers } from "./support/credentials.js";
import { FakeAssistant } from "./support/fake-assistant.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";
import { asUsers } from "./support/user-api.js";

/** 网关的启动停在这里：`entered` 在走到网关的启动时调用（HTTP 此刻已在监听），`released` 等放行。 */
const gate = vi.hoisted(() => ({
	entered: (): void => undefined,
	released: Promise.resolve() as Promise<void>,
	release: (): void => undefined,
}));

vi.mock("../src/gateway/agent-gateway.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/gateway/agent-gateway.js")>();
	return {
		...actual,
		startAgentGateway: async (...args: Parameters<typeof actual.startAgentGateway>) => {
			gate.entered();
			await gate.released;
			return actual.startAgentGateway(...args);
		},
	};
});

const { startControlPlane } = await import("../src/control-plane.js");

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

const freePort = async (): Promise<number> => {
	const holder = createServer();
	await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
	const port = (holder.address() as { port: number }).port;
	await new Promise<void>((resolve) => holder.close(() => resolve()));
	return port;
};

describe("启动时 HTTP 已经监听、助手服务的事件连接还没建好：请求回 503，不是 500", () => {
	let database: TestDatabase;
	let dataDir: string;
	let assistant: FakeAssistant;

	beforeEach(async () => {
		database = await createTestDatabase("sfly_startup", { dropWaitMs: 200 });
		dataDir = await mkdtemp(join(tmpdir(), "sfly-startup-window-"));
		assistant = await FakeAssistant.start();
	});
	afterEach(async () => {
		await assistant.close();
		await rm(dataDir, { recursive: true, force: true });
		await database.drop();
	});

	it("就绪状态写助手服务连不上（200，ready 为假），建会话 503 assistant_unavailable、什么也没写；放行之后照常启动", async () => {
		const port = await freePort();
		const entered = new Promise<void>((resolve) => {
			gate.entered = resolve;
		});
		gate.released = new Promise<void>((resolve) => {
			gate.release = resolve;
		});
		const starting = startControlPlane({
			databaseUrl: database.url,
			dataDir,
			http: { host: "127.0.0.1", port },
			grpc: { host: "127.0.0.1", port: 0 },
			assistantUrl: assistant.url,
			assistantSecret: assistant.secret,
			sessionSweepIntervalMs: 3_600_000,
		});
		let plane: Awaited<typeof starting> | undefined;
		try {
			// 路由登记完、HTTP 监听上，走到网关的启动（在这里停住）：此刻助手服务的事件连接对象还没有建。
			await entered;
			// 工作台登记了（直接写库：迁移已经跑完，Agent 还没有连上来），这样就绪状态里只剩助手服务的事件流还没连上。
			const pgClient = new pg.Client({ connectionString: database.url });
			await pgClient.connect();
			try {
				await pgClient.query(
					"update projects set workbench_agent = 'workbench-startup' where id = 'default'",
				);
			} finally {
				await pgClient.end();
			}
			const users = new TestUsers(database.url);
			const api = new ApiClient(
				asUsers({
					users,
					fetch: async (path, init = {}) =>
						fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: await users.sign(init) }),
				}),
			);

			const list = await api.get("/projects/default/sessions");
			expect(list.status).toBe(200);
			const view = await json<SessionListResponse>(list);
			expect(view.readiness.ready).toBe(false);
			expect(view.readiness.problems.map((problem) => problem.kind)).toContain(
				"assistant_unreachable",
			);

			const created = await api.post("/projects/default/sessions", { text: "启动的那几毫秒" });
			expect(created.status).toBe(503);
			expect((await json<{ error: { code: string } }>(created)).error.code).toBe(
				"assistant_unavailable",
			);
			const after = await json<SessionListResponse>(await api.get("/projects/default/sessions"));
			expect(after.sessions).toEqual([]);
		} finally {
			gate.release();
			plane = await starting.catch(() => undefined);
			await plane?.close();
		}
	}, 60_000);
});
