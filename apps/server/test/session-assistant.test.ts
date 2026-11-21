// 助手会话和助手服务的连接（ADR 0027，规格 #541 第二个 PR）：建会话、发话、停止把一轮交给助手服务，助手服务推回的事件落库并
// 推给浏览器，断了重连，助手没有配置、连不上、拒绝时的 503 和 409，就绪状态。真实控制面 + 真实数据库 + 进程内的假助手服务
// （support/fake-assistant.ts，说 @sfly/schema 的协议，记下收到的命令，测试往它的事件流里推事件）。
import { randomUUID } from "node:crypto";
import {
	type AssistantEvent,
	PersistedSessionEvent,
	type Readiness,
	type SessionDetailResponse,
	type SessionListResponse,
	SessionView,
} from "@sfly/schema";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { FAKE_SECRET, FakeAssistant } from "./support/fake-assistant.js";
import type { ManualClock } from "./support/manual-clock.js";
import { seedSession } from "./support/sessions.js";
import { SseClient } from "./support/sse-client.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const WORKBENCH = "workbench-a";
const USAGE = { input: 10, output: 5, cache_read: 0, cache_write: 0 };
const assistantMessage = (text: string): AssistantEvent => ({
	type: "assistant_message",
	text,
	usage: USAGE,
});
const turnEnd = (
	turn: number,
	outcome: "completed" | "stopped" = "completed",
	reason = "助手已完成",
): AssistantEvent => ({
	type: "turn_end",
	turn,
	outcome,
	reason,
	steps: 1,
	model_calls: 1,
	duration_ms: 1000,
	usage: USAGE,
});

/** 一个会话的当前行（直接读库）。 */
async function sessionRow(cp: TestControlPlane, id: string) {
	const client = new pg.Client({ connectionString: cp.database.url });
	await client.connect();
	try {
		const { rows } = await client.query("select * from sessions where id = $1", [id]);
		return rows[0] as { status: string; title: string; created_by: string } | undefined;
	} finally {
		await client.end();
	}
}

async function sessionCount(cp: TestControlPlane): Promise<number> {
	const client = new pg.Client({ connectionString: cp.database.url });
	await client.connect();
	try {
		const { rows } = await client.query("select count(*)::int as n from sessions");
		return rows[0].n as number;
	} finally {
		await client.end();
	}
}

describe("助手服务接上了：建会话、发话、停止、收回事件", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let assistant: FakeAssistant;
	let workbench: FakeAgent;

	beforeAll(async () => {
		assistant = await FakeAssistant.start();
		cp = await startTestControlPlane({
			assistantUrl: assistant.url,
			assistantSecret: assistant.secret,
			workbenchAgent: WORKBENCH,
			assistantReconnectMs: { min: 20, max: 100 },
		});
		api = new ApiClient(cp);
		// 工作台：一台在线的 Agent，上报了能力端口。
		workbench = await FakeAgent.connect(
			cp.grpcUrl,
			{ name: WORKBENCH, peer: { port: 7001, publicAddress: "10.0.0.5" } },
			{ clock: cp.clock },
		);
		await assistant.connected();
	}, 60_000);

	afterAll(async () => {
		await workbench?.disconnect();
		await cp?.close();
		await assistant?.close();
	});

	beforeEach(async () => {
		// 每个用例从没有在做的会话、助手服务没有收到过命令开始。
		const client = new pg.Client({ connectionString: cp.database.url });
		await client.connect();
		try {
			await client.query("delete from sessions");
		} finally {
			await client.end();
		}
		assistant.prompts.length = 0;
		assistant.aborts.length = 0;
		assistant.promptReply = () => undefined;
		assistant.health = () => assistant.healthy();
	});

	const create = (text = "给 http_check 加一个超时参数", nickname = "alice") =>
		api.post("/projects/default/sessions", { text }, nickname);

	it("建会话：201，助手服务收到这一轮（带共享密钥、工作台的地址和端口、工作区、昵称和 AI_AGENT=pi），第一句话和一轮开始落了库", async () => {
		const res = await create("  给 http_check\n加一个超时参数  ", "alice");
		expect(res.status).toBe(201);
		const view = await json<SessionView>(res);
		expect(SessionView.safeParse(view).success).toBe(true);
		expect(view).toMatchObject({
			title: "给 http_check 加一个超时参数",
			status: "running",
			created_by: "alice",
			project: "default",
			last_turn_outcome: null,
		});

		expect(assistant.prompts).toHaveLength(1);
		const [prompt] = assistant.prompts;
		expect(prompt?.sessionId).toBe(view.id);
		expect(prompt?.authorization).toBe(`Bearer ${FAKE_SECRET}`);
		expect(prompt?.body).toMatchObject({
			turn: 1,
			text: "  给 http_check\n加一个超时参数  ",
			session: { title: view.title, created_by: "alice" },
			workbench: { name: WORKBENCH, address: "10.0.0.5:7001", workdir: "/work" },
			env: { SFLY_NICKNAME: "alice", AI_AGENT: "pi" },
			secret_env: {},
		});

		const detail = await json<SessionDetailResponse>(await api.get(`/sessions/${view.id}`));
		expect(detail.events.map((e) => [e.seq, e.type])).toEqual([
			[1, "user_message"],
			[2, "turn_started"],
		]);
		expect(detail.events[0]).toMatchObject({
			// 这句话的 ID：和交给助手服务的是同一个。
			message_id: prompt?.body.message_id,
			text: "  给 http_check\n加一个超时参数  ",
			steer: false,
			author: "alice",
			author_user_id: null,
		});
		expect(detail.events[1]).toMatchObject({ turn: 1 });
		// 控制面自己产生的事件用控制面的时钟。
		expect(detail.events[0]?.at).toBe(cp.clock.now().toISOString());
	});

	it("助手服务推回的事件落库、经事件流推给浏览器；读到的持久事件和事件流推送的一致，时间是助手服务盖的", async () => {
		const view = await json<SessionView>(await create());
		const sse = await SseClient.open(cp, `/sessions/${view.id}/events`);
		try {
			await sse.next("turn_started");
			const at = "2026-01-01T00:00:05.000Z";
			assistant.emit(view.id, 1, { type: "thinking" }, at);
			assistant.emit(view.id, 1, { type: "assistant_delta", text: "我先" }, at);
			assistant.emit(view.id, 1, assistantMessage("我先看一下"), at);
			assistant.emit(
				view.id,
				1,
				{ type: "tool_call", call_id: "c1", tool: "command", title: "sfly package list" },
				"2026-01-01T00:00:06.000Z",
			);
			await sse.next("tool_call");
			// 不持久的没有 ID，持久的以会话内序号作 ID（接在建会话时的两条后面）。
			const events = sse.received.filter((e) => e.event !== "time");
			expect(events.map((e) => [e.event, e.id])).toEqual([
				["user_message", "1"],
				["turn_started", "2"],
				["thinking", undefined],
				["assistant_delta", undefined],
				["assistant_message", "3"],
				["tool_call", "4"],
			]);
			const detail = await json<SessionDetailResponse>(await api.get(`/sessions/${view.id}`));
			expect(detail.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
			// 事件流推送的持久事件和读到的是同一份（内容、序号、时间）。
			const pushed = events.filter((e) => e.id !== undefined).map((e) => e.data);
			expect(pushed).toEqual(detail.events);
			for (const event of detail.events) {
				expect(PersistedSessionEvent.safeParse(event).success, event.type).toBe(true);
			}
			// 时间是助手服务盖的，不是控制面落库的时间。
			expect(detail.events[2]?.at).toBe(at);
			expect(detail.events[3]?.at).toBe("2026-01-01T00:00:06.000Z");
		} finally {
			sse.close();
		}
	});

	it("一轮结束（turn_end）：会话回到空闲，上一轮的结局进了列表，可以开始下一轮（第 2 轮）", async () => {
		const view = await json<SessionView>(await create());
		assistant.emit(view.id, 1, assistantMessage("好了"));
		assistant.emit(view.id, 1, turnEnd(1));
		await eventually(async () => expect((await sessionRow(cp, view.id))?.status).toBe("idle"));
		const list = await json<SessionListResponse>(await api.get("/projects/default/sessions"));
		expect(list.sessions).toHaveLength(1);
		expect(list.sessions[0]).toMatchObject({
			id: view.id,
			status: "idle",
			last_turn_outcome: "completed",
		});

		const said = await api.post(`/sessions/${view.id}/messages`, { text: "再加一条日志" }, "bob");
		expect(said.status).toBe(200);
		const { seq } = await json<{ seq: number }>(said);
		expect(assistant.prompts).toHaveLength(2);
		expect(assistant.prompts[1]?.body).toMatchObject({
			turn: 2,
			text: "再加一条日志",
			// 会话的发起人不变；这句话的发起人是 bob。
			session: { created_by: "alice" },
			env: { SFLY_NICKNAME: "bob", AI_AGENT: "pi" },
		});
		const detail = await json<SessionDetailResponse>(await api.get(`/sessions/${view.id}`));
		const spoken = detail.events.find((e) => e.seq === seq);
		expect(spoken).toMatchObject({ type: "user_message", text: "再加一条日志", author: "bob" });
		expect((await sessionRow(cp, view.id))?.status).toBe("running");
	});

	it("在做时发话：409 turn_running；同一个项目另一个会话在做时建会话：409 project_busy，说明里写明是哪个；收到 turn_end 之后都可以", async () => {
		const first = await json<SessionView>(await create("第一个"));
		const busy = await api.post(`/sessions/${first.id}/messages`, { text: "再说一句" });
		expect(busy.status).toBe(409);
		expect((await json<{ error: { code: string } }>(busy)).error.code).toBe("turn_running");

		const other = await create("第二个");
		expect(other.status).toBe(409);
		const { error } = await json<{ error: { code: string; message: string } }>(other);
		expect(error.code).toBe("project_busy");
		expect(error.message).toContain("第一个");
		expect(error.message).toContain(first.id);
		// 没有新建会话，助手服务也没有收到第二个 prompt。
		expect(await sessionCount(cp)).toBe(1);
		expect(assistant.prompts).toHaveLength(1);

		assistant.emit(first.id, 1, turnEnd(1));
		await eventually(async () => expect((await sessionRow(cp, first.id))?.status).toBe("idle"));
		expect((await create("第二个")).status).toBe(201);
	});

	it("并发建会话：同一个项目只有一个成功，另一个 409 project_busy", async () => {
		const results = await Promise.all([create("甲"), create("乙"), create("丙")]);
		const statuses = results.map((r) => r.status).sort();
		expect(statuses).toEqual([201, 409, 409]);
		expect(await sessionCount(cp)).toBe(1);
		expect(assistant.prompts).toHaveLength(1);
	});

	it("并发对同一个会话发话：只有一个开始新的一轮", async () => {
		const view = await json<SessionView>(await create());
		assistant.emit(view.id, 1, turnEnd(1));
		await eventually(async () => expect((await sessionRow(cp, view.id))?.status).toBe("idle"));
		assistant.prompts.length = 0;
		const results = await Promise.all(
			["甲", "乙", "丙"].map((text) => api.post(`/sessions/${view.id}/messages`, { text })),
		);
		expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
		expect(assistant.prompts).toHaveLength(1);
	});

	it("已结束的会话发话：409 session_ended", async () => {
		const id = await seedSession(cp.database.url, { status: "ended" });
		const res = await api.post(`/sessions/${id}/messages`, { text: "还在吗" });
		expect(res.status).toBe(409);
		expect((await json<{ error: { code: string } }>(res)).error.code).toBe("session_ended");
		expect(assistant.prompts).toHaveLength(0);
	});

	it("停止：在做时助手服务收到中止，这一轮的 turn_end 由助手服务的事件带回来；不在做时什么也不做", async () => {
		const view = await json<SessionView>(await create());
		const stopped = await api.post(`/sessions/${view.id}/stop`, {});
		expect(stopped.status).toBe(200);
		expect(assistant.aborts).toEqual([view.id]);
		// 控制面没有自己改状态：等助手服务的事件。
		expect(await json<SessionView>(stopped)).toMatchObject({ id: view.id, status: "running" });
		assistant.emit(view.id, 1, turnEnd(1, "stopped", "用户停止"));
		await eventually(async () => expect((await sessionRow(cp, view.id))?.status).toBe("idle"));

		// 不在做：不发中止，返回当前状态。
		const again = await api.post(`/sessions/${view.id}/stop`, {});
		expect(again.status).toBe(200);
		expect(assistant.aborts).toEqual([view.id]);
		expect(await json<SessionView>(again)).toMatchObject({
			status: "idle",
			last_turn_outcome: "stopped",
		});
	});

	it("助手服务没接住第一轮：新建的会话删掉（不留下会话），503 assistant_unavailable 或它给的原因", async () => {
		for (const [reply, status, code] of [
			[
				{ status: 503, code: "start_failed", message: "起不了 pi 进程" },
				503,
				"assistant_unavailable",
			],
			[
				{ status: 503, code: "process_limit", message: "进程数到了上限" },
				503,
				"assistant_unavailable",
			],
			[
				{ status: 503, code: "model_not_configured", message: "没有配置模型" },
				503,
				"model_unavailable",
			],
			[{ status: 503, code: "model_unreachable", message: "模型连不上" }, 503, "model_unavailable"],
			[{ status: 409, code: "turn_running", message: "已有一轮在做" }, 409, "turn_running"],
		] as const) {
			assistant.promptReply = () => reply;
			const res = await create();
			expect(res.status, reply.code).toBe(status);
			const { error } = await json<{ error: { code: string; message: string } }>(res);
			expect(error.code, reply.code).toBe(code);
			expect(error.message, reply.code).toContain(reply.message);
			expect(await sessionCount(cp), reply.code).toBe(0);
		}
	});

	it("共享密钥不对：助手服务拒绝（401），控制面说明是密钥不一致，不把密钥写进说明", async () => {
		const wrong = await FakeAssistant.start({ secret: "another-secret-0123456789-0123456789-xx" });
		const other = await startTestControlPlane({
			assistantUrl: wrong.url,
			// 控制面这边的密钥和助手服务那边的不一样（同样够长）。
			assistantSecret: FAKE_SECRET,
			workbenchAgent: WORKBENCH,
			assistantReconnectMs: { min: 20, max: 100 },
		});
		const agent = await FakeAgent.connect(
			other.grpcUrl,
			{ name: WORKBENCH, peer: { port: 7001, publicAddress: "10.0.0.5" } },
			{ clock: other.clock },
		);
		try {
			const res = await new ApiClient(other).post("/projects/default/sessions", { text: "你好" });
			expect(res.status).toBe(503);
			const text = await res.text();
			expect(text).toContain("assistant_unavailable");
			expect(text).toContain("SFLY_ASSISTANT_SECRET");
			expect(text).not.toContain(FAKE_SECRET);
			expect(wrong.unauthorized).toBeGreaterThan(0);
			expect(wrong.prompts).toHaveLength(0);
			// 就绪状态：助手服务连不上（健康检查被拒绝）。
			const list = await json<SessionListResponse>(
				await new ApiClient(other).get("/projects/default/sessions"),
			);
			expect(list.readiness.problems.map((p) => p.kind)).toContain("assistant_unreachable");
			expect(JSON.stringify(list)).not.toContain(FAKE_SECRET);
		} finally {
			await agent.disconnect();
			await other.close();
			await wrong.close();
		}
	});

	describe("助手服务没接住后面的一轮：用户的话还在历史里，补一条失败的结局，会话回到空闲", () => {
		it("连不上助手服务", async () => {
			const view = await json<SessionView>(await create());
			assistant.emit(view.id, 1, turnEnd(1));
			await eventually(async () => expect((await sessionRow(cp, view.id))?.status).toBe("idle"));
			await assistant.stop();
			try {
				const res = await api.post(`/sessions/${view.id}/messages`, { text: "再来一次" });
				expect(res.status).toBe(503);
				expect((await json<{ error: { code: string } }>(res)).error.code).toBe(
					"assistant_unavailable",
				);
			} finally {
				await assistant.resume();
				await assistant.connected();
			}
			const detail = await json<SessionDetailResponse>(await api.get(`/sessions/${view.id}`));
			expect(detail.status).toBe("idle");
			const types = detail.events.map((e) => e.type);
			expect(types.slice(-3)).toEqual(["user_message", "turn_started", "turn_end"]);
			expect(detail.events.at(-1)).toMatchObject({
				type: "turn_end",
				turn: 2,
				outcome: "failed",
				steps: 0,
				model_calls: 0,
			});
			expect(detail.last_turn_outcome).toBe("failed");
		});

		it("模型不可用", async () => {
			const view = await json<SessionView>(await create());
			assistant.emit(view.id, 1, turnEnd(1));
			await eventually(async () => expect((await sessionRow(cp, view.id))?.status).toBe("idle"));
			assistant.promptReply = () => ({
				status: 503,
				code: "model_unreachable",
				message: "模型连不上",
			});
			const res = await api.post(`/sessions/${view.id}/messages`, { text: "再来一次" });
			expect(res.status).toBe(503);
			expect((await json<{ error: { code: string } }>(res)).error.code).toBe("model_unavailable");
			const detail = await json<SessionDetailResponse>(await api.get(`/sessions/${view.id}`));
			expect(detail.events.at(-1)).toMatchObject({
				type: "turn_end",
				outcome: "model_unavailable",
				error_class: "other",
			});
			expect(detail.status).toBe("idle");
		});
	});

	it("助手服务连不上时建会话：503 assistant_unavailable，库里没有这个会话", async () => {
		await assistant.stop();
		try {
			const res = await create();
			expect(res.status).toBe(503);
			const { error } = await json<{ error: { code: string; message: string } }>(res);
			expect(error.code).toBe("assistant_unavailable");
			expect(error.message).toContain("连不上助手服务");
			expect(await sessionCount(cp)).toBe(0);
		} finally {
			await assistant.resume();
			await assistant.connected();
		}
		// 恢复之后同一个项目照常能建（之前失败的那次没有占着「在做」）。
		expect((await create()).status).toBe(201);
	});

	describe("事件连接", () => {
		it("不认识的会话、不是约定形状的行：丢掉，连接继续", async () => {
			const view = await json<SessionView>(await create());
			assistant.emit(randomUUID(), 1, assistantMessage("没人要的"));
			assistant.emitRaw("这不是 JSON");
			assistant.emitRaw(JSON.stringify({ epoch: "x", session_id: view.id }));
			assistant.emit(view.id, 1, assistantMessage("这条要落库"));
			await eventually(async () => {
				const detail = await json<SessionDetailResponse>(await api.get(`/sessions/${view.id}`));
				expect(detail.events.map((e) => e.type)).toContain("assistant_message");
			});
			expect(assistant.streams).toBe(1);
		});

		it("断了按退避重连：重连之后的事件照常落库（断线期间的丢掉，续传是 #545）", async () => {
			const view = await json<SessionView>(await create());
			assistant.dropStreams();
			assistant.emit(view.id, 1, assistantMessage("断线期间的"));
			await assistant.connected();
			assistant.emit(view.id, 1, assistantMessage("重连之后的"));
			await eventually(async () => {
				const detail = await json<SessionDetailResponse>(await api.get(`/sessions/${view.id}`));
				const texts = detail.events.flatMap((e) =>
					e.type === "assistant_message" ? [e.text] : [],
				);
				expect(texts).toEqual(["重连之后的"]);
			});
		});

		it("助手服务连不上又好了：连接自己恢复", async () => {
			const view = await json<SessionView>(await create());
			await assistant.stop();
			await new Promise((r) => setTimeout(r, 150));
			await assistant.resume();
			await assistant.connected();
			assistant.emit(view.id, 1, assistantMessage("恢复了"));
			await eventually(async () => {
				const detail = await json<SessionDetailResponse>(await api.get(`/sessions/${view.id}`));
				expect(detail.events.map((e) => e.type)).toContain("assistant_message");
			});
		});

		it("助手服务产生的事件时间原样存；同一个会话的事件按到达的先后依次落库，序号连续", async () => {
			const view = await json<SessionView>(await create());
			for (let n = 1; n <= 30; n++) {
				assistant.emit(view.id, 1, assistantMessage(`第 ${n} 条`), "2026-02-01T00:00:00.000Z");
			}
			await eventually(async () => {
				const detail = await json<SessionDetailResponse>(await api.get(`/sessions/${view.id}`));
				expect(detail.events).toHaveLength(32);
			});
			const detail = await json<SessionDetailResponse>(await api.get(`/sessions/${view.id}`));
			expect(detail.events.map((e) => e.seq)).toEqual(Array.from({ length: 32 }, (_, i) => i + 1));
			const texts = detail.events.flatMap((e) => (e.type === "assistant_message" ? [e.text] : []));
			expect(texts).toEqual(Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 条`));
			expect(detail.events.at(-1)?.at).toBe("2026-02-01T00:00:00.000Z");
		}, 20_000);
	});

	describe("就绪状态", () => {
		const readiness = async (): Promise<Readiness> =>
			(await json<SessionListResponse>(await api.get("/projects/default/sessions"))).readiness;

		it("都好：可用，带工作台的名字；助手服务的 /health 缓存 30 秒", async () => {
			expect(await readiness()).toEqual({ ready: true, problems: [], workbench: WORKBENCH });
			// 30 秒内助手服务连不上也不重新问（读缓存）；之后问一遍，写明原因。
			await assistant.stop();
			try {
				expect((await readiness()).ready).toBe(true);
				(cp.clock as ManualClock).advance(31_000);
				const now = await readiness();
				expect(now.ready).toBe(false);
				expect(now.problems).toEqual([expect.objectContaining({ kind: "assistant_unreachable" })]);
				expect(now.problems[0]?.message).toContain("连不上助手服务");
				expect(now.workbench).toBe(WORKBENCH);
			} finally {
				await assistant.resume();
				await assistant.connected();
				(cp.clock as ManualClock).advance(31_000);
			}
			expect((await readiness()).ready).toBe(true);
		});

		it("工作台不在线：workbench_offline，写明是哪一台；上线之后又好了", async () => {
			await workbench.disconnect();
			try {
				await eventually(async () => {
					const now = await readiness();
					expect(now.problems).toEqual([expect.objectContaining({ kind: "workbench_offline" })]);
					expect(now.problems[0]?.message).toContain(WORKBENCH);
					expect(now.workbench).toBe(WORKBENCH);
				});
				// 写接口：503 assistant_unavailable，说明是工作台不在线，没有新建会话。
				const res = await create();
				expect(res.status).toBe(503);
				const { error } = await json<{ error: { code: string; message: string } }>(res);
				expect(error.code).toBe("assistant_unavailable");
				expect(error.message).toContain(WORKBENCH);
				expect(await sessionCount(cp)).toBe(0);
			} finally {
				workbench = await FakeAgent.connect(
					cp.grpcUrl,
					{ name: WORKBENCH, peer: { port: 7001, publicAddress: "10.0.0.5" } },
					{ clock: cp.clock },
				);
			}
			await eventually(async () => expect((await readiness()).ready).toBe(true));
		});
	});
});

describe("工作台的各种不能用", () => {
	let assistant: FakeAssistant;
	beforeAll(async () => {
		assistant = await FakeAssistant.start();
	});
	afterAll(async () => {
		await assistant?.close();
	});

	const withControlPlane = async (
		options: { workbenchAgent?: string },
		run: (cp: TestControlPlane, api: ApiClient) => Promise<void>,
	) => {
		const cp = await startTestControlPlane({
			assistantUrl: assistant.url,
			assistantSecret: assistant.secret,
			assistantReconnectMs: { min: 20, max: 100 },
			...options,
		});
		try {
			await run(cp, new ApiClient(cp));
		} finally {
			await cp.close();
		}
	};

	it("没有设置工作台：workbench_not_set，写接口 503 assistant_unavailable，助手服务没有收到命令", async () => {
		await withControlPlane({}, async (cp, api) => {
			const list = await json<SessionListResponse>(await api.get("/projects/default/sessions"));
			expect(list.readiness).toMatchObject({ ready: false, workbench: null });
			expect(list.readiness.problems.map((p) => p.kind)).toEqual(["workbench_not_set"]);
			const res = await api.post("/projects/default/sessions", { text: "你好" });
			expect(res.status).toBe(503);
			expect((await json<{ error: { code: string } }>(res)).error.code).toBe(
				"assistant_unavailable",
			);
			expect(assistant.prompts).toHaveLength(0);
			expect(await sessionCount(cp)).toBe(0);
		});
	});

	it("工作台没有上报能力端口：workbench_offline，写明原因", async () => {
		await withControlPlane({ workbenchAgent: "no-port" }, async (cp, api) => {
			const agent = await FakeAgent.connect(cp.grpcUrl, { name: "no-port" }, { clock: cp.clock });
			try {
				const list = await json<SessionListResponse>(await api.get("/projects/default/sessions"));
				expect(list.readiness.problems).toEqual([
					expect.objectContaining({ kind: "workbench_offline" }),
				]);
				expect(list.readiness.problems[0]?.message).toContain("能力端口");
			} finally {
				await agent.disconnect();
			}
		});
	});

	it("工作台是别的项目里的 Agent：workbench_not_set", async () => {
		await withControlPlane({ workbenchAgent: "elsewhere" }, async (cp, api) => {
			const agent = await FakeAgent.connect(
				cp.grpcUrl,
				{ name: "elsewhere", peer: { port: 7002 } },
				{ clock: cp.clock },
			);
			const client = new pg.Client({ connectionString: cp.database.url });
			await client.connect();
			try {
				await client.query(
					"insert into projects (id, display_name, created_at) values ('other', 'other', now())",
				);
				await client.query("update agents set project_id = 'other' where name = 'elsewhere'");
				const list = await json<SessionListResponse>(await api.get("/projects/default/sessions"));
				expect(list.readiness.problems).toEqual([
					expect.objectContaining({ kind: "workbench_not_set" }),
				]);
				expect(list.readiness.problems[0]?.message).toContain("不属于这个项目");
			} finally {
				await client.end();
				await agent.disconnect();
			}
		});
	});

	it("共享密钥太短：当作没有配置，原因写明（写接口 503 assistant_not_configured），助手服务不会被连", async () => {
		const cp = await startTestControlPlane({
			assistantUrl: assistant.url,
			assistantSecret: "too-short",
			workbenchAgent: "w",
		});
		try {
			const api = new ApiClient(cp);
			const list = await json<SessionListResponse>(await api.get("/projects/default/sessions"));
			expect(list.readiness.problems[0]).toMatchObject({ kind: "assistant_not_configured" });
			expect(list.readiness.problems[0]?.message).toContain("32");
			expect(list.readiness.problems[0]?.message).not.toContain("too-short");
			const res = await api.post("/projects/default/sessions", { text: "你好" });
			expect(res.status).toBe(503);
			expect((await json<{ error: { code: string } }>(res)).error.code).toBe(
				"assistant_not_configured",
			);
		} finally {
			await cp.close();
		}
	});
});

describe("兜底：一直在做的会话不会让项目永远开不了新的一轮", () => {
	let assistant: FakeAssistant;
	let cp: TestControlPlane;
	let workbench: FakeAgent;
	let api: ApiClient;

	beforeAll(async () => {
		assistant = await FakeAssistant.start();
		cp = await startTestControlPlane({
			assistantUrl: assistant.url,
			assistantSecret: assistant.secret,
			workbenchAgent: WORKBENCH,
			assistantReconnectMs: { min: 20, max: 100 },
			sessionSweepIntervalMs: 20,
		});
		api = new ApiClient(cp);
		workbench = await FakeAgent.connect(
			cp.grpcUrl,
			{ name: WORKBENCH, peer: { port: 7001, publicAddress: "10.0.0.5" } },
			{ clock: cp.clock },
		);
	}, 60_000);
	afterAll(async () => {
		await workbench?.disconnect();
		await cp?.close();
		await assistant?.close();
	});

	const advance = (ms: number) => (cp.clock as ManualClock).advance(ms);

	it("超过 30 分钟没有持久事件的在做的会话：补一条结局为 interrupted 的 turn_end，会话回到空闲，项目可以再开始新的一轮；刚有过事件的不动", async () => {
		const view = await json<SessionView>(
			await api.post("/projects/default/sessions", { text: "第一个" }),
		);
		expect(view.status).toBe("running");
		// 29 分钟：还不算。
		advance(29 * 60_000);
		await new Promise((r) => setTimeout(r, 120));
		expect((await sessionRow(cp, view.id))?.status).toBe("running");
		expect((await api.post("/projects/default/sessions", { text: "第二个" })).status).toBe(409);
		// 持久的事件算活动：时间重新从这条算起。
		assistant.emit(view.id, 1, assistantMessage("还在做"), cp.clock.now());
		await eventually(async () => {
			const detail = await json<SessionDetailResponse>(await api.get(`/sessions/${view.id}`));
			expect(detail.events.map((e) => e.type)).toContain("assistant_message");
		});
		advance(29 * 60_000);
		await new Promise((r) => setTimeout(r, 120));
		expect((await sessionRow(cp, view.id))?.status).toBe("running");
		// 再过两分钟，超过 30 分钟了。
		advance(2 * 60_000);
		await eventually(async () => expect((await sessionRow(cp, view.id))?.status).toBe("idle"));
		const detail = await json<SessionDetailResponse>(await api.get(`/sessions/${view.id}`));
		expect(detail.events.at(-1)).toMatchObject({
			type: "turn_end",
			turn: 1,
			outcome: "interrupted",
		});
		expect(detail.last_turn_outcome).toBe("interrupted");
		// 这个项目又能开始新的一轮了。
		expect((await api.post("/projects/default/sessions", { text: "第二个" })).status).toBe(201);
	});

	it("控制面启动时先收拾一遍：重启之前一直在做的会话回到空闲，没过期的不动", async () => {
		// 单独起一个控制面，扫描间隔很长：只有启动时那一遍。
		const other = await startTestControlPlane({
			assistantUrl: assistant.url,
			assistantSecret: assistant.secret,
			workbenchAgent: WORKBENCH,
			assistantReconnectMs: { min: 20, max: 100 },
		});
		try {
			const stale = await seedSession(other.database.url, {
				status: "running",
				title: "重启前的",
				lastActivityAt: new Date(other.clock.now().getTime() - 40 * 60_000),
			});
			await other.restart();
			const list = await json<SessionListResponse>(
				await new ApiClient(other).get("/projects/default/sessions"),
			);
			expect(list.sessions).toEqual([
				expect.objectContaining({ id: stale, status: "idle", last_turn_outcome: "interrupted" }),
			]);
			// 新的在做的会话（刚有活动）重启之后不动。
			const fresh = await seedSession(other.database.url, {
				status: "running",
				title: "刚做的",
				lastActivityAt: other.clock.now(),
			});
			await other.restart();
			const after = await json<SessionListResponse>(
				await new ApiClient(other).get("/projects/default/sessions"),
			);
			expect(after.sessions.find((x) => x.id === fresh)?.status).toBe("running");
		} finally {
			await other.close();
		}
	});
});
