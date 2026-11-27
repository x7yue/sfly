// 换一台工作台（`PUT /projects/:project/workbench` 再登记一次，#549）：在做的一轮在原来的工作台上做完（这一轮开始时交给
// 助手服务的是当时的工作台，登记不打断它、不重发），**下一轮**（对这个会话再说话，或者新建会话）才交给新的工作台；
// 就绪状态和写接口每次读库里登记的那一台，不缓存。真实控制面和数据库，进程内的假助手服务，两台假 Agent 当工作台。
import type { AssistantEvent, SessionListResponse, SessionView } from "@sfly/schema";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { bearer, TestAccounts } from "./support/credentials.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { FakeAssistant } from "./support/fake-assistant.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";
import { asUsers } from "./support/user-api.js";

const JSON_HEADERS = { "content-type": "application/json" };
const USAGE = { input: 10, output: 5, cache_read: 0, cache_write: 0 };
const turnEnd = (turn: number): AssistantEvent => ({
	type: "turn_end",
	turn,
	outcome: "completed",
	reason: "测试",
	steps: 1,
	model_calls: 1,
	duration_ms: 1000,
	usage: USAGE,
});
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

describe("换一台工作台：在做的一轮在原来的上做完，下一轮交给新的", () => {
	let assistant: FakeAssistant;
	let cp: TestControlPlane;
	let accounts: TestAccounts;
	let db: pg.Client;
	let api: ApiClient;
	let boss: Record<string, string>;
	const workbenches: FakeAgent[] = [];

	beforeEach(async () => {
		assistant = await FakeAssistant.start();
		cp = await startTestControlPlane({
			assistantUrl: assistant.url,
			assistantSecret: assistant.secret,
			assistantReconnectMs: { min: 20, max: 100 },
		});
		accounts = new TestAccounts(cp.database.url);
		db = new pg.Client({ connectionString: cp.database.url });
		await db.connect();
		const bossId = await accounts.user("boss");
		await accounts.member("default", bossId, "project_admin");
		boss = bearer(await accounts.personalToken(bossId));
		api = new ApiClient(asUsers(cp));
		for (const [name, port, address] of [
			["wb-1", 7001, "10.0.0.5"],
			["wb-2", 7002, "10.0.0.6"],
		] as const) {
			workbenches.push(
				await FakeAgent.connect(
					cp.grpcUrl,
					{ name, peer: { port, publicAddress: address } },
					{ clock: cp.clock },
				),
			);
		}
		await assistant.connected();
	});
	afterEach(async () => {
		await Promise.all(workbenches.splice(0).map((agent) => agent.disconnect()));
		await db.end();
		await accounts.close();
		await cp.close();
		await assistant.close();
	});

	const register = async (agent: string) => {
		const res = await cp.fetch("/projects/default/workbench", {
			method: "PUT",
			headers: { ...JSON_HEADERS, ...boss },
			body: JSON.stringify({ agent }),
		});
		expect(res.status, await res.clone().text()).toBe(200);
		const { agent: registered, previous_agent: previous } = await json<{
			agent: string;
			previous_agent: string | null;
		}>(res);
		return { agent: registered, previous_agent: previous };
	};
	const readiness = async () =>
		(await json<SessionListResponse>(await api.get("/projects/default/sessions"))).readiness;
	const status = async (id: string) =>
		(await db.query("select status from sessions where id = $1", [id])).rows[0]?.status as string;
	const workbenchOf = (index: number) => assistant.prompts[index]?.body.workbench;

	it("登记 wb-1，开一轮；换成 wb-2：这一轮不被打断、不重发，在 wb-1 上做完；对这个会话再说话和新建会话都交给 wb-2；就绪状态跟着换", async () => {
		expect(await register("wb-1")).toEqual({ agent: "wb-1", previous_agent: null });
		expect(await readiness()).toMatchObject({ ready: true, workbench: "wb-1" });

		const first = await json<SessionView>(
			await api.post("/projects/default/sessions", { text: "第一件事" }, "alice"),
		);
		expect(assistant.prompts).toHaveLength(1);
		expect(workbenchOf(0)).toMatchObject({ name: "wb-1", address: "10.0.0.5:7001" });

		// 这一轮还在做的时候换成 wb-2：先 wb-1 这台还连着（登记的条件只看工作台本身）。
		expect(await register("wb-2")).toEqual({ agent: "wb-2", previous_agent: "wb-1" });
		expect(await readiness()).toMatchObject({ ready: true, workbench: "wb-2", problems: [] });
		// 这一轮不受影响：助手服务没有收到中止、没有收到第二个 prompt，会话还在做。
		expect(assistant.aborts).toEqual([]);
		expect(assistant.prompts).toHaveLength(1);
		expect(await status(first.id)).toBe("running");

		// 在做的一轮在原来的工作台上做完（助手服务带回结局），会话回到空闲，还是只有那一个 prompt。
		assistant.emit(first.id, 1, turnEnd(1));
		await eventually(async () => expect(await status(first.id)).toBe("idle"));
		expect(assistant.prompts).toHaveLength(1);

		// 下一轮：对这个会话再说话，交给 wb-2。
		const said = await api.post(`/sessions/${first.id}/messages`, { text: "第二件事" }, "alice");
		expect(said.status, await said.clone().text()).toBeLessThan(300);
		await eventually(() => expect(assistant.prompts).toHaveLength(2));
		expect(assistant.prompts[1]?.body).toMatchObject({ turn: 2 });
		expect(workbenchOf(1)).toMatchObject({ name: "wb-2", address: "10.0.0.6:7002" });
		assistant.emit(first.id, 2, turnEnd(2));
		await eventually(async () => expect(await status(first.id)).toBe("idle"));

		// 新建会话也是 wb-2。
		const second = await json<SessionView>(
			await api.post("/projects/default/sessions", { text: "另一个会话" }, "bob"),
		);
		expect(second.id).not.toBe(first.id);
		expect(assistant.prompts).toHaveLength(3);
		expect(workbenchOf(2)).toMatchObject({ name: "wb-2", address: "10.0.0.6:7002" });
	}, 60_000);

	it("换下来的 wb-1 掉线也不影响：就绪状态只看登记的那一台", async () => {
		await register("wb-1");
		await register("wb-2");
		await workbenches[0]?.disconnect();
		expect(await readiness()).toMatchObject({ ready: true, workbench: "wb-2", problems: [] });
		await workbenches[1]?.disconnect();
		const gone = await readiness();
		expect(gone).toMatchObject({ ready: false, workbench: "wb-2" });
		expect(gone.problems[0]?.message).toContain("wb-2");
	}, 60_000);
});
