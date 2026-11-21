// 助手会话和它的事件（ADR 0027，规格 #541 第一个 PR）：落库（序号、时间、内容过 schema）、读接口、事件流（补发加实时、
// 按事件 ID 续上）、助手没有配置时写接口的 503。真实控制面 + 真实数据库；助手服务的连接在第二个 PR，
// 这里用控制面的会话模块（`cp.current.sessions`）直接写事件、推事件。
import { randomUUID } from "node:crypto";
import {
	PERSISTED_SESSION_EVENT_TYPES,
	PersistedSessionEvent,
	SESSION_HISTORY_PAGE,
	type SessionDetailResponse,
	type SessionEventBody,
	type SessionListResponse,
	SessionView,
	sessionEventSchemas,
} from "@sfly/schema";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_PROJECT } from "../src/projects/project-id.js";
import { SessionNotFoundError } from "../src/sessions/session-store.js";
import { ApiClient } from "./support/api-client.js";
import { bearer, loginCookie, TestAccounts } from "./support/credentials.js";
import { eventually } from "./support/eventually.js";
import type { ManualClock } from "./support/manual-clock.js";
import { messageId, persistedBodies, seedSession } from "./support/sessions.js";
import { SseClient } from "./support/sse-client.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";
import { diffFootprints, settledFootprint } from "./support/write-footprint.js";

let cp: TestControlPlane;
let api: ApiClient;
beforeAll(async () => {
	cp = await startTestControlPlane();
	api = new ApiClient(cp);
}, 60_000);
afterAll(async () => {
	await cp?.close();
});

const store = () => cp.current.sessions;
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const T0 = new Date("2026-01-01T00:00:00.000Z");
const userBody = (n: number) => ({
	type: "user_message" as const,
	message_id: messageId(n),
	text: `第 ${n} 句`,
	steer: false,
	author: "alice",
	author_user_id: null,
});

/** 在默认项目里建一个没有事件的会话（控制面的会话模块）。 */
const newSession = (status: "idle" | "running" | "queued" | "ended" = "idle") =>
	store().create({
		project: DEFAULT_PROJECT,
		title: "测试会话",
		status,
		createdBy: "alice",
		createdByUserId: null,
	});

describe("事件落库：序号、时间、内容", () => {
	it("并发写同一个会话的事件：序号连续、不重复，每条事件都落了库", async () => {
		const { id } = await newSession();
		const written = await Promise.all(
			Array.from({ length: 20 }, (_, i) => store().append(id, userBody(i % 9))),
		);
		expect(written.map((e) => e.seq).sort((a, b) => a - b)).toEqual(
			Array.from({ length: 20 }, (_, i) => i + 1),
		);
		const { events } = await store().page(id);
		expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
	});

	it("序号在每个会话里各自从 1 起", async () => {
		const [a, b] = [await newSession(), await newSession()];
		expect((await store().append(a.id, userBody(1))).seq).toBe(1);
		expect((await store().append(a.id, userBody(2))).seq).toBe(2);
		expect((await store().append(b.id, userBody(1))).seq).toBe(1);
	});

	it("每种持久事件都能落库、读回，内容过 @sfly/schema 的 schema，读回的和写入时返回的一样", async () => {
		const { id } = await newSession();
		const bodies = persistedBodies();
		expect(new Set(bodies.map((b) => b.type))).toEqual(new Set(PERSISTED_SESSION_EVENT_TYPES));
		const written: PersistedSessionEvent[] = [];
		for (const body of bodies) written.push(await store().append(id, body));
		const { events } = await store().page(id);
		expect(events).toEqual(written);
		for (const event of events) {
			expect(PersistedSessionEvent.safeParse(event).success, event.type).toBe(true);
			// 读的一方的 schema（SSE 的每种事件）也认它。
			expect(sessionEventSchemas[event.type].safeParse(event).success, event.type).toBe(true);
		}
		// 库里存的是「除 type 以外的字段」。
		const body = bodies[0] as SessionEventBody;
		const { type, ...rest } = body;
		const client = new pg.Client({ connectionString: cp.database.url });
		await client.connect();
		try {
			const { rows } = await client.query(
				"select type, payload from session_events where session_id = $1 and seq = 1",
				[id],
			);
			expect(rows[0]).toEqual({ type, payload: rest });
		} finally {
			await client.end();
		}
	});

	it("不合格的内容、不持久的事件、不存在的会话：写不进去，库里没有残留", async () => {
		const { id } = await newSession();
		await expect(
			store().append(id, { type: "turn_started", turn: 0 } as SessionEventBody),
		).rejects.toThrow();
		await expect(store().append(id, { type: "thinking" } as SessionEventBody)).rejects.toThrow(
			/不持久/,
		);
		await expect(store().append(randomUUID(), userBody(1))).rejects.toThrow(SessionNotFoundError);
		expect((await store().page(id)).events).toEqual([]);
		expect(() => store().publish(id, userBody(1))).toThrow(/持久的/);
	});

	it("事件的时间是事件产生的时间：不传用控制面的时钟，传了原样存；会话的最近活动不会因为旧的事件时间倒退", async () => {
		const { id } = await newSession();
		(cp.clock as ManualClock).set("2026-03-01T00:00:00.000Z");
		const own = await store().append(id, userBody(1));
		expect(own.at).toBe("2026-03-01T00:00:00.000Z");
		// 助手服务盖的时间：比控制面的时钟早（控制面重启之后补收的一批事件）。
		const stamped = await store().append(id, userBody(2), new Date("2026-02-28T23:59:00.000Z"));
		expect(stamped.at).toBe("2026-02-28T23:59:00.000Z");
		const row = await store().find(id);
		expect(row?.lastActivityAt.toISOString()).toBe("2026-03-01T00:00:00.000Z");
		const later = await store().append(id, userBody(3), new Date("2026-03-02T00:00:00.000Z"));
		expect((await store().find(id))?.lastActivityAt.toISOString()).toBe(later.at);
	});
});

describe("读：一页事件、列表、上一轮的结局", () => {
	it("一页最多 200 条（最新的），before 往前翻，has_more 说明前面还有", async () => {
		const total = SESSION_HISTORY_PAGE + 5;
		const id = await seedSession(cp.database.url, {
			events: Array.from({ length: total }, (_, i) => userBody(i % 9)),
		});
		const first = await json<SessionDetailResponse>(await api.get(`/sessions/${id}`));
		expect(first.events).toHaveLength(SESSION_HISTORY_PAGE);
		expect(first.events[0]?.seq).toBe(6);
		expect(first.events.at(-1)?.seq).toBe(total);
		expect(first.has_more).toBe(true);
		const second = await json<SessionDetailResponse>(await api.get(`/sessions/${id}?before=6`));
		expect(second.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
		expect(second.has_more).toBe(false);
		// 恰好一页：没有更多。
		const exact = await seedSession(cp.database.url, {
			events: Array.from({ length: SESSION_HISTORY_PAGE }, (_, i) => userBody(i % 9)),
		});
		expect((await json<SessionDetailResponse>(await api.get(`/sessions/${exact}`))).has_more).toBe(
			false,
		);
	});

	it("会话视图：字段、项目、就绪状态、上一轮的结局；读到的事件过 schema", async () => {
		const id = await seedSession(cp.database.url, {
			title: "加超时",
			createdBy: "bob",
			events: persistedBodies(),
		});
		const detail = await json<SessionDetailResponse>(await api.get(`/sessions/${id}`));
		expect(SessionView.safeParse(detail).success).toBe(true);
		expect(detail).toMatchObject({
			id,
			title: "加超时",
			status: "idle",
			created_by: "bob",
			project: "default",
			queue_position: null,
			waiting_for: null,
			last_turn_outcome: "completed",
			has_more: false,
		});
		expect(detail.readiness.ready).toBe(false);
		expect(detail.events.map((e) => e.seq)).toEqual(persistedBodies().map((_, i) => i + 1));
		for (const event of detail.events) {
			expect(PersistedSessionEvent.safeParse(event).success, event.type).toBe(true);
		}
	});

	it("上一轮的结局取最近一条 turn_end；没有结束过的一轮是 null", async () => {
		const { id } = await newSession();
		expect(await store().lastOutcome(id)).toBeNull();
		const turnEnd = (turn: number, outcome: "stopped" | "failed") =>
			({
				type: "turn_end",
				turn,
				outcome,
				reason: "x",
				duration_ms: 1,
			}) as const;
		await store().append(id, turnEnd(1, "stopped"));
		await store().append(id, userBody(1));
		expect(await store().lastOutcome(id)).toBe("stopped");
		await store().append(id, turnEnd(2, "failed"));
		expect(await store().lastOutcome(id)).toBe("failed");
	});

	it("列表：在做和排队中的在前，其余按最近活动倒序；只列这个项目的会话", async () => {
		await using_project("list-order", async (project) => {
			const mk = (title: string, status: "idle" | "running" | "queued" | "ended", minute: number) =>
				seedSession(cp.database.url, {
					project,
					title,
					status,
					lastActivityAt: new Date(T0.getTime() + minute * 60_000),
				});
			await mk("旧的空闲", "idle", 1);
			await mk("新的空闲", "idle", 9);
			await mk("已结束", "ended", 20);
			await mk("排队中", "queued", 2);
			await mk("在做的", "running", 0);
			// 别的项目的会话不出现。
			await seedSession(cp.database.url, { title: "默认项目的会话" });
			const list = await json<SessionListResponse>(await api.get(`/projects/${project}/sessions`));
			expect(list.sessions.map((s) => s.title)).toEqual([
				"排队中",
				"在做的",
				"已结束",
				"新的空闲",
				"旧的空闲",
			]);
			expect(list.sessions.map((s) => s.status)).toEqual([
				"queued",
				"running",
				"ended",
				"idle",
				"idle",
			]);
		});
	});

	it("列表的就绪状态：助手没有配置，写明原因；工作台没有设置也列出来；没有会话时是空数组", async () => {
		await using_project("empty-project", async (project) => {
			const list = await json<SessionListResponse>(await api.get(`/projects/${project}/sessions`));
			expect(list.sessions).toEqual([]);
			expect(list.readiness).toEqual({
				ready: false,
				workbench: null,
				problems: [
					expect.objectContaining({ kind: "assistant_not_configured" }),
					expect.objectContaining({ kind: "workbench_not_set" }),
				],
			});
			expect(list.readiness.problems[0]?.message).toContain("SFLY_ASSISTANT_URL");
		});
	});

	it("项目不存在、写法不对、会话不存在、ID 不是 UUID、拿任务的 ID 当会话：都是 404", async () => {
		for (const path of [
			"/projects/no-such-project/sessions",
			"/projects/Bad_Name/sessions",
			`/sessions/${randomUUID()}`,
			"/sessions/not-a-uuid",
			`/sessions/${randomUUID()}/events`,
		]) {
			const res = await api.get(path);
			expect(res.status, path).toBe(404);
			expect(await json<{ error: { code: string } }>(res)).toMatchObject({
				error: { code: "not_found" },
			});
		}
	});
});

describe("事件流：补发加实时", () => {
	const idsOf = (sse: SseClient) =>
		sse.received.filter((e) => e.event !== "time").map((e) => [e.event, e.id]);

	it("连上先从库里补发全部持久事件（事件名是类型，以序号作事件 ID），再接实时的；不持久的事件没有 ID", async () => {
		const { id } = await newSession();
		await store().append(id, userBody(1));
		await store().append(id, { type: "turn_started", turn: 1 });
		const sse = await SseClient.open(cp, `/sessions/${id}/events`);
		try {
			await sse.next("user_message");
			await sse.next("turn_started");
			// 实时：不持久的（文字增量）和持久的（助手的消息）。
			store().publish(id, { type: "assistant_delta", text: "我先" });
			const live = await store().append(id, {
				type: "assistant_message",
				text: "我先看一下",
				usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 },
			});
			expect(live.seq).toBe(3);
			await sse.next("assistant_delta");
			await sse.next("assistant_message");
			expect(idsOf(sse)).toEqual([
				["user_message", "1"],
				["turn_started", "2"],
				["assistant_delta", undefined],
				["assistant_message", "3"],
			]);
			// 每条事件的内容（data）过读的一方的 schema；持久的带 seq 和 at。
			for (const event of sse.received.filter((e) => e.event !== "time")) {
				expect(
					sessionEventSchemas[event.event as keyof typeof sessionEventSchemas].safeParse(event.data)
						.success,
					event.event,
				).toBe(true);
			}
			expect(sse.received.find((e) => e.event === "assistant_message")?.data).toMatchObject({
				seq: 3,
				type: "assistant_message",
			});
		} finally {
			sse.close();
		}
	});

	it("带 Last-Event-ID 重连：落库的事件不重不漏；after 和 Last-Event-ID 取较大的一个", async () => {
		const { id } = await newSession();
		for (let n = 1; n <= 5; n++) await store().append(id, userBody(n));
		const resumed = await SseClient.open(cp, `/sessions/${id}/events`, { "last-event-id": "3" });
		try {
			await resumed.next("user_message");
			await resumed.next("user_message");
			store().publish(id, { type: "thinking" });
			await store().append(id, userBody(6));
			await resumed.next("thinking");
			await resumed.next("user_message");
			expect(idsOf(resumed)).toEqual([
				["user_message", "4"],
				["user_message", "5"],
				["thinking", undefined],
				["user_message", "6"],
			]);
		} finally {
			resumed.close();
		}
		// 较大的一个：after=4、Last-Event-ID=2 → 从 4 之后。
		const both = await SseClient.open(cp, `/sessions/${id}/events?after=4`, {
			"last-event-id": "2",
		});
		try {
			await both.next("user_message");
			await both.next("user_message");
			expect(idsOf(both)).toEqual([
				["user_message", "5"],
				["user_message", "6"],
			]);
			await both.expectNone(150);
		} finally {
			both.close();
		}
		// Last-Event-ID 写成不是数字的：当作没有，从头补发。
		const garbage = await SseClient.open(cp, `/sessions/${id}/events`, { "last-event-id": "abc" });
		try {
			for (let n = 0; n < 6; n++) await garbage.next("user_message");
			expect(idsOf(garbage).map(([, eventId]) => eventId)).toEqual(["1", "2", "3", "4", "5", "6"]);
		} finally {
			garbage.close();
		}
	});

	it("补发的同时有新事件落库：不重不漏，顺序不乱（补发期间的实时事件排在补发之后，按序号去重）", async () => {
		const id = await seedSession(cp.database.url, {
			events: Array.from({ length: 450 }, (_, i) => userBody(i % 9)),
		});
		const sse = await SseClient.open(cp, `/sessions/${id}/events`);
		try {
			// 连上之后马上写：补发 450 条（要读几批）的同时来了新事件。
			await Promise.all(Array.from({ length: 5 }, () => store().append(id, userBody(1))));
			await eventually(
				() => expect(sse.received.filter((e) => e.event === "user_message")).toHaveLength(455),
				10_000,
			);
			const seqs = sse.received.filter((e) => e.event === "user_message").map((e) => Number(e.id));
			expect(seqs).toEqual(Array.from({ length: 455 }, (_, i) => i + 1));
		} finally {
			sse.close();
		}
	}, 30_000);

	it("别的会话的事件不会推给这条流", async () => {
		const [a, b] = [await newSession(), await newSession()];
		const sse = await SseClient.open(cp, `/sessions/${a.id}/events`);
		try {
			await sse.next("time");
			await store().append(b.id, userBody(1));
			store().publish(b.id, { type: "thinking" });
			await sse.expectNone(150);
			await store().append(a.id, userBody(2));
			await sse.next("user_message");
		} finally {
			sse.close();
		}
	});
});

describe("助手没有配置：写接口 503，读接口照常", () => {
	it("新建、发话、停止都是 503 assistant_not_configured，说明里写明原因；库里什么都没有变", async () => {
		const id = await seedSession(cp.database.url, { events: persistedBodies() });
		const before = await settledFootprint(cp.database.url, cp.dataDir);
		for (const res of [
			await api.post("/projects/default/sessions", { text: "你好" }),
			await api.post(`/sessions/${id}/messages`, { text: "你好" }),
			await api.post(`/sessions/${id}/stop`, {}),
		]) {
			expect(res.status).toBe(503);
			const { error } = await json<{ error: { code: string; message: string } }>(res);
			expect(error.code).toBe("assistant_not_configured");
			expect(error.message).toContain("SFLY_ASSISTANT_URL");
		}
		expect(diffFootprints(before, await settledFootprint(cp.database.url, cp.dataDir))).toEqual([]);
	});

	it("写接口先查请求：没有昵称 400、正文不合格 400、项目或会话不存在 404，然后才是 503", async () => {
		const id = await seedSession(cp.database.url);
		const noNickname = await cp.fetch("/projects/default/sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "你好" }),
		});
		expect(noNickname.status).toBe(400);
		expect((await json<{ error: { code: string } }>(noNickname)).error.code).toBe(
			"nickname_required",
		);
		for (const text of ["", "   ", "x".repeat(20_001)]) {
			expect(
				(await api.post("/projects/default/sessions", { text })).status,
				text.slice(0, 8),
			).toBe(400);
			expect((await api.post(`/sessions/${id}/messages`, { text })).status).toBe(400);
		}
		expect((await api.post("/projects/no-such-project/sessions", { text: "你好" })).status).toBe(
			404,
		);
		expect((await api.post(`/sessions/${randomUUID()}/messages`, { text: "你好" })).status).toBe(
			404,
		);
		expect((await api.post(`/sessions/${randomUUID()}/stop`, {})).status).toBe(404);
	});
});

describe("有凭据的请求：会话的写要「编辑」范围，读要「读」，别的项目的成员 404", () => {
	let accounts: TestAccounts;
	let sessionId: string;
	let headers: {
		reader: Record<string, string>;
		editor: Record<string, string>;
		other: Record<string, string>;
	};

	beforeAll(async () => {
		accounts = new TestAccounts(cp.database.url);
		sessionId = await seedSession(cp.database.url, { events: persistedBodies() });
		const reader = await accounts.user("sessions_reader");
		const editor = await accounts.user("sessions_editor");
		const other = await accounts.user("sessions_other");
		await accounts.project("sessions-elsewhere");
		await accounts.member("default", reader, "read_only");
		await accounts.member("default", editor, "editor");
		await accounts.member("sessions-elsewhere", other, "project_admin");
		headers = {
			reader: bearer(await accounts.personalToken(reader)),
			editor: loginCookie(await accounts.login(editor)),
			other: bearer(await accounts.personalToken(other)),
		};
	});
	afterAll(async () => {
		await accounts?.close();
	});

	const call = (who: keyof typeof headers, method: string, path: string, body?: unknown) =>
		cp.fetch(path, {
			method,
			headers: {
				...headers[who],
				"content-type": "application/json",
				"x-sfly-nickname": "tester",
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});

	it("只读成员：读得到列表和会话，写是 403；编辑者的写走到处理函数（助手没有配置：503）", async () => {
		expect((await call("reader", "GET", "/projects/default/sessions")).status).toBe(200);
		expect((await call("reader", "GET", `/sessions/${sessionId}`)).status).toBe(200);
		for (const [path, body] of [
			["/projects/default/sessions", { text: "你好" }],
			[`/sessions/${sessionId}/messages`, { text: "你好" }],
			[`/sessions/${sessionId}/stop`, {}],
		] as const) {
			expect((await call("reader", "POST", path, body)).status, path).toBe(403);
			expect((await call("editor", "POST", path, body)).status, path).toBe(503);
		}
	});

	it("别的项目的成员：列表、会话、事件流、写都是 404，说法和不存在一样", async () => {
		for (const [method, path, body] of [
			["GET", "/projects/default/sessions", undefined],
			["GET", `/sessions/${sessionId}`, undefined],
			["GET", `/sessions/${sessionId}/events`, undefined],
			["POST", "/projects/default/sessions", { text: "你好" }],
			["POST", `/sessions/${sessionId}/messages`, { text: "你好" }],
			["POST", `/sessions/${sessionId}/stop`, {}],
		] as const) {
			const res = await call("other", method, path, body);
			expect(res.status, `${method} ${path}`).toBe(404);
		}
	});
});

/** 建一个临时项目跑一段，结束后会话留在库里（每个测试用自己的项目，互不影响）。 */
async function using_project(id: string, run: (project: string) => Promise<void>): Promise<void> {
	const accounts = new TestAccounts(cp.database.url);
	try {
		await accounts.project(id);
	} finally {
		await accounts.close();
	}
	await run(id);
}
