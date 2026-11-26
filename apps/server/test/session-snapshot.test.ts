// 事件流里的快照（#545 S 块，src/sessions/session-store.ts 的 `follow` 和 live-state.ts）：控制面在内存里按会话累着这一轮已经输出的文字、
// 在跑的工具调用和它输出的最后一段、最新的插话队列、排队的位置；补发读完、切到实时的那一刻给**这一条连接**发一条 `snapshot`，
// 带 `after` / `Last-Event-ID` 重连的连接也一样。真实数据库，真的 `SessionStore`（累积只来自 `publishFromAssistant` 和落库发布的那条路）。
import { randomUUID } from "node:crypto";
import {
	SECRET_MASK,
	SESSION_EVENT_LIMITS,
	type SessionEvent,
	sessionEventSchemas,
} from "@sfly/schema";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/db/database.js";
import type { ProjectId } from "../src/projects/project-id.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { TestAccounts } from "./support/credentials.js";
import { eventually } from "./support/eventually.js";
import { ManualClock } from "./support/manual-clock.js";
import { messageId } from "./support/sessions.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

const LIMIT = SESSION_EVENT_LIMITS.runningToolOutputBytes;
const HEX = "0123456789abcdef0011223344556677889900aabbccddeeff".slice(0, 48);
const TOKEN = `sfly_ses_${HEX}`;
const AT = new Date("2026-01-01T00:00:00.000Z");

type Snapshot = Extract<SessionEvent, { type: "snapshot" }>;

const opening = {
	type: "user_message" as const,
	message_id: messageId(1),
	text: "一句话",
	steer: false,
	author: "alice",
	author_user_id: null,
};
const delta = (text: string) => ({ type: "assistant_delta" as const, text });
const output = (callId: string, text: string) => ({
	type: "tool_output" as const,
	call_id: callId,
	text,
});
const toolCall = (callId: string, title = "sleep 600") => ({
	type: "tool_call" as const,
	call_id: callId,
	tool: "command" as const,
	title,
});
const toolResult = (callId: string) => ({
	type: "tool_result" as const,
	call_id: callId,
	is_error: false,
	text: "ok",
	truncated: false,
	exit_code: 0,
	duration_ms: 1,
});
const message = (text: string) => ({
	type: "assistant_message" as const,
	text,
	usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 },
});
const steerQueue = (...ids: string[]) => ({
	type: "steer_queue" as const,
	messages: ids.map((message_id) => ({ message_id, text: `话 ${message_id.slice(-2)}` })),
});
const turnEnd = (turn: number) => ({
	type: "turn_end" as const,
	turn,
	outcome: "completed" as const,
	reason: "助手已完成",
	duration_ms: 1,
});

describe("事件流里的快照", () => {
	let testDb: TestDatabase;
	let database: ReturnType<typeof openDatabase>;
	let store: SessionStore;
	let author: string;
	const clock = new ManualClock(AT);

	beforeAll(async () => {
		testDb = await createTestDatabase();
		database = openDatabase(testDb.url, () => {});
		await database.migrate();
		const accounts = new TestAccounts(testDb.url);
		try {
			author = await accounts.user("snapshot_author");
		} finally {
			await accounts.close();
		}
		store = new SessionStore({ db: database.db, clock });
	});
	afterAll(async () => {
		await database.close();
		await testDb.drop();
	});
	// 停住读库的用例失败时不能把后面的用例都卡住。
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const newProject = async (): Promise<ProjectId> => {
		const id = `s-${randomUUID().slice(0, 8)}`;
		await database.pool.query(
			"insert into projects (id, display_name, created_at) values ($1, $1, now())",
			[id],
		);
		return id as ProjectId;
	};
	const newSession = (project: ProjectId, status: "idle" | "queued" = "idle", title = "快照") =>
		store.create({ project, title, status, createdBy: "alice", createdByUserId: author });

	/** 一个正在做第 1 轮的会话（和助手服务连上之后一样：`beginTurn` 写 user_message、turn_started）。 */
	const running = async () => {
		const project = await newProject();
		const { id } = await newSession(project);
		const begun = await store.beginTurn(id, project, opening);
		if (begun.outcome !== "started") throw new Error("没有开始");
		return { id, project, turn: begun.turn };
	};

	/** 助手服务发来的事件：持久的落库发布，不持久的发布（控制面的核对和第二道打码都在里面）。 */
	const fromAssistant = async (
		id: string,
		turn: number,
		event: Parameters<SessionStore["appendFromAssistant"]>[2],
	) => {
		if (["assistant_message", "tool_call", "tool_result", "turn_end"].includes(event.type)) {
			return store.appendFromAssistant(id, turn, event, AT);
		}
		return store.publishFromAssistant(id, turn, event);
	};

	/** 打开一条事件流（`store.follow`）：收下补发和实时的全部事件，快照单独记着。 */
	const open = (sessionId: string, after = 0) => {
		const out: SessionEvent[] = [];
		const stop = store.follow(
			sessionId,
			after,
			{ emit: (event) => out.push(event), drained: () => Promise.resolve() },
			(error) => {
				throw error;
			},
		);
		const snapshots = () => out.filter((event): event is Snapshot => event.type === "snapshot");
		return { out, stop, snapshots };
	};
	const shape = (out: SessionEvent[]) => out.map((e) => ("seq" in e ? e.seq : e.type));

	/** 打开、等快照到、关掉：返回快照（每条连接恰好一条）。 */
	const snapshotOf = async (sessionId: string, after = 0): Promise<Snapshot> => {
		const { snapshots, stop } = open(sessionId, after);
		try {
			await eventually(() => expect(snapshots()).toHaveLength(1));
			return snapshots()[0] as Snapshot;
		} finally {
			stop();
		}
	};

	describe("位置：补发读完、切到实时的那一刻，只发给这一条连接", () => {
		it("先补发全部持久事件，再发快照，之后是实时的；快照过读的一方的 schema，没有序号", async () => {
			const { id, turn } = await running();
			const { out, stop, snapshots } = open(id);
			await eventually(() => expect(shape(out)).toEqual([1, 2, "snapshot"]));
			await fromAssistant(id, turn, delta("实时的"));
			await eventually(() => expect(shape(out)).toEqual([1, 2, "snapshot", "assistant_delta"]));
			expect(snapshots()).toHaveLength(1);
			const snapshot = snapshots()[0] as Snapshot;
			expect("seq" in snapshot).toBe(false);
			expect(sessionEventSchemas.snapshot.safeParse(snapshot).success).toBe(true);
			stop();
		});

		it("带 after 重连的连接同样在补发读完的那一刻收到一条：只补发 after 之后的，快照仍在最后", async () => {
			const { id, turn } = await running();
			await fromAssistant(id, turn, message("第一条"));
			await fromAssistant(id, turn, message("第二条"));
			const { out, stop } = open(id, 2);
			await eventually(() => expect(shape(out)).toEqual([3, 4, "snapshot"]));
			stop();
		});

		it("只发给这一条连接：别的连接不会因为它收到第二条；每条连接各一条", async () => {
			const { id, turn } = await running();
			const first = open(id);
			await eventually(() => expect(first.snapshots()).toHaveLength(1));
			const second = open(id);
			await eventually(() => expect(second.snapshots()).toHaveLength(1));
			await fromAssistant(id, turn, delta("后来的增量"));
			await fromAssistant(id, turn, message("整条"));
			await eventually(() => expect(shape(first.out).at(-1)).toBe(3));
			// 第二条连接连上时第一条连接没有收到新的快照。
			expect(first.snapshots()).toHaveLength(1);
			expect(second.snapshots()).toHaveLength(1);
			first.stop();
			second.stop();
		});

		it("补发很多批：快照在最后一批之后、不在批与批之间", async () => {
			const { id, turn } = await running();
			for (let n = 0; n < 5; n++) await fromAssistant(id, turn, message(`第 ${n} 条`));
			const out: SessionEvent[] = [];
			const stop = store.follow(
				id,
				0,
				{ emit: (event) => out.push(event), drained: () => Promise.resolve() },
				(error) => {
					throw error;
				},
			);
			await eventually(() => expect(out.at(-1)?.type).toBe("snapshot"));
			expect(out.filter((e) => e.type === "snapshot")).toHaveLength(1);
			expect(shape(out)).toEqual([1, 2, 3, 4, 5, 6, 7, "snapshot"]);
			stop();
		});

		it("补发读库期间到的增量先放，快照在它们之后，里面已经包括它们（页面按取代处理，不会重复）", async () => {
			const { id, turn } = await running();
			await fromAssistant(id, turn, delta("补发之前的"));
			// 停住补发的读库；期间来增量。
			const original = store.after.bind(store);
			let release!: () => void;
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			let reading!: () => void;
			const readStarted = new Promise<void>((resolve) => {
				reading = resolve;
			});
			const spy = vi.spyOn(store, "after").mockImplementation(async (...args) => {
				reading();
				await held;
				return original(...args);
			});
			const { out, stop } = open(id);
			try {
				await readStarted;
				// 补发的读库占着这个会话的链：期间到的增量只能走不排链的 `publish`（和事件流的缓冲正好重叠）。
				store.publish(id, delta("，停住期间的"));
				release();
				await eventually(() => expect(out.at(-1)?.type).toBe("snapshot"));
				const types = out.map((e) => e.type);
				expect(types.indexOf("assistant_delta")).toBeLessThan(types.indexOf("snapshot"));
				const snapshot = out.at(-1) as Snapshot;
				expect(snapshot.partial_text).toBe("补发之前的，停住期间的");
			} finally {
				spy.mockRestore();
				stop();
			}
		});
	});

	describe("内容：累积、清空", () => {
		it("这一轮已经输出的文字：上一条持久的助手消息之后收到的全部增量；整条消息到了就清空，之后的增量重新累积", async () => {
			const { id, turn } = await running();
			await fromAssistant(id, turn, { type: "thinking" });
			await fromAssistant(id, turn, delta("我先"));
			await fromAssistant(id, turn, delta("看一下"));
			expect(await snapshotOf(id)).toMatchObject({ status: "running", partial_text: "我先看一下" });
			// 带着已经收到的序号重连的页面也拿到：增量不持久，补发里没有。
			expect(await snapshotOf(id, 2)).toMatchObject({ partial_text: "我先看一下" });
			await fromAssistant(id, turn, message("我先看一下现有的节点。"));
			expect((await snapshotOf(id)).partial_text).toBe("");
			await fromAssistant(id, turn, delta("然后"));
			expect((await snapshotOf(id)).partial_text).toBe("然后");
		});

		it("正在跑的工具：tool_call 到 tool_result 之间；输出是最后一段；结果到了就没有", async () => {
			const { id, turn } = await running();
			expect((await snapshotOf(id)).running_tool).toBeNull();
			await fromAssistant(id, turn, toolCall("c1", "sfly run start 巡检"));
			await fromAssistant(id, turn, output("c1", "第一行\n"));
			await fromAssistant(id, turn, output("c1", "第二行\n"));
			expect((await snapshotOf(id)).running_tool).toEqual({
				call_id: "c1",
				tool: "command",
				title: "sfly run start 巡检",
				output: "第一行\n第二行\n",
			});
			await fromAssistant(id, turn, toolResult("c1"));
			expect((await snapshotOf(id)).running_tool).toBeNull();
		});

		it("输出的最后一段至多 runningToolOutputBytes 个字节，不切开字符", async () => {
			const { id, turn } = await running();
			await fromAssistant(id, turn, toolCall("c1"));
			const lines = Array.from({ length: 4000 }, (_, i) => `行 ${String(i).padStart(5, "0")}\n`);
			for (const line of lines) await fromAssistant(id, turn, output("c1", line));
			const tool = (await snapshotOf(id)).running_tool;
			expect(Buffer.byteLength(tool?.output ?? "", "utf8")).toBeLessThanOrEqual(LIMIT);
			expect(Buffer.byteLength(tool?.output ?? "", "utf8")).toBeGreaterThan(LIMIT - 8);
			expect(lines.join("").endsWith(tool?.output ?? "")).toBe(true);
			expect(tool?.output).not.toContain("�");
		});

		it("最新的插话队列", async () => {
			const { id, turn } = await running();
			const [a, b] = [messageId(1), messageId(2)];
			await fromAssistant(id, turn, steerQueue(a, b));
			await fromAssistant(id, turn, steerQueue(b));
			expect((await snapshotOf(id)).steer_queue.map((m) => m.message_id)).toEqual([b]);
			await fromAssistant(id, turn, steerQueue());
			expect((await snapshotOf(id)).steer_queue).toEqual([]);
		});

		it("一轮结束、会话结束时清空：所有现场都没有，状态是空闲", async () => {
			const { id, turn } = await running();
			await fromAssistant(id, turn, delta("半截"));
			await fromAssistant(id, turn, toolCall("c1"));
			await fromAssistant(id, turn, output("c1", "输出"));
			await fromAssistant(id, turn, steerQueue(messageId(2)));
			expect(await snapshotOf(id)).toMatchObject({ partial_text: "半截" });
			await fromAssistant(id, turn, turnEnd(turn));
			expect(await snapshotOf(id)).toMatchObject({
				status: "idle",
				partial_text: "",
				running_tool: null,
				steer_queue: [],
			});
			// 下一轮的现场从头累积，不带上一轮的。
			const second = await store.beginTurn(id, (await store.find(id))?.projectId as ProjectId, {
				...opening,
				message_id: messageId(3),
			});
			if (second.outcome !== "started") throw new Error("没有开始第 2 轮");
			await fromAssistant(id, second.turn, delta("第二轮"));
			expect((await snapshotOf(id)).partial_text).toBe("第二轮");
			const ended = await store.appendTurnEnd(id, turnEnd(second.turn));
			expect(ended.type).toBe("turn_end");
			await store.end(id, "alice");
			expect(await snapshotOf(id)).toMatchObject({ status: "ended", partial_text: "" });
		});

		it("没有在做的一轮时不带现场（内存里留着的也不发）：快照的状态来自库", async () => {
			const project = await newProject();
			const { id } = await newSession(project);
			// 不经助手服务校验的发布（只有控制面自己的 `publish` 走这条路）：内存里有，但会话是空闲的。
			store.publish(id, { type: "assistant_delta", text: "过时的" });
			expect(await snapshotOf(id)).toMatchObject({
				status: "idle",
				partial_text: "",
				running_tool: null,
				steer_queue: [],
			});
		});

		it("没有通过控制面校验的事件不累积：上一轮迟到的增量、空闲的会话收到的增量", async () => {
			const { id, turn } = await running();
			const late = await store.publishFromAssistant(id, turn + 1, delta("别的轮次的"));
			expect(late).toEqual({ dropped: "other_turn" });
			const stray = await store.publishFromAssistant(id, turn, {
				type: "tool_output",
				call_id: "没见过的调用",
				text: "没有 tool_call",
			});
			expect(stray).toEqual({ published: true });
			expect(await snapshotOf(id)).toMatchObject({
				partial_text: "",
				running_tool: null,
			});
			await fromAssistant(id, turn, turnEnd(turn));
			const idle = await store.publishFromAssistant(id, turn, delta("一轮结束之后的"));
			expect(idle).toEqual({ dropped: "not_running" });
			expect((await snapshotOf(id)).partial_text).toBe("");
		});

		it("各个会话互不影响", async () => {
			const [a, b] = [await running(), await running()];
			await fromAssistant(a.id, a.turn, delta("甲"));
			await fromAssistant(b.id, b.turn, delta("乙"));
			expect((await snapshotOf(a.id)).partial_text).toBe("甲");
			expect((await snapshotOf(b.id)).partial_text).toBe("乙");
		});

		it("断线期间错过的增量：重连的连接在快照里拿到全部", async () => {
			const { id, turn } = await running();
			const before = open(id);
			await eventually(() => expect(before.snapshots()).toHaveLength(1));
			await fromAssistant(id, turn, delta("断线之前，"));
			await eventually(() => expect(before.out.at(-1)).toMatchObject({ type: "assistant_delta" }));
			before.stop(); // 浏览器断线
			await fromAssistant(id, turn, delta("断线期间的，"));
			await fromAssistant(id, turn, delta("也都在。"));
			const resumed = await snapshotOf(id, 2);
			expect(resumed.partial_text).toBe("断线之前，断线期间的，也都在。");
		});

		it("会话被删：现场一起清掉，同一个 ID 不会带出旧的文字", async () => {
			const { id, turn } = await running();
			await fromAssistant(id, turn, delta("要被删掉的"));
			await store.delete(id);
			// 同一个 ID 又出现一个在做的会话（测试里直接写库）：内存里不能还留着删掉的那个会话的文字。
			const project = await newProject();
			await database.pool.query(
				`insert into sessions (id, project_id, title, status, created_by, created_by_user_id, created_at, last_activity_at, current_turn)
				values ($1::uuid, $2, 'x', 'running', 'a', $3, now(), now(), 1)`,
				[id, project, author],
			);
			expect((await snapshotOf(id)).partial_text).toBe("");
		});
	});

	describe("快照里的文字不漏会话令牌", () => {
		it("令牌被拆在两条增量里：逐条打码认不出，快照里整段打过码，没有原值，也没有半截", async () => {
			const { id, turn } = await running();
			await fromAssistant(id, turn, delta("令牌是 sfly_ses_"));
			await fromAssistant(id, turn, delta(`${HEX} 请收好`));
			const text = (await snapshotOf(id)).partial_text;
			expect(text).toBe(`令牌是 ${SECRET_MASK} 请收好`);
			expect(text).not.toContain(HEX.slice(0, 8));
			expect(text).not.toContain(HEX.slice(-8));
		});

		it("拆在令牌字符中间：推给订阅者的前半截已经被逐条打码换成掩码，快照里连后半截也没有", async () => {
			for (const cut of [10, 24, 40]) {
				const { id, turn } = await running();
				await fromAssistant(id, turn, delta(`令牌是 ${TOKEN.slice(0, cut)}`));
				await fromAssistant(id, turn, delta(`${TOKEN.slice(cut)} 请收好`));
				const text = (await snapshotOf(id)).partial_text;
				expect(text, `cut ${cut}`).toBe(`令牌是 ${SECRET_MASK} 请收好`);
			}
		});

		it("一条增量里的完整令牌换成掩码", async () => {
			const { id, turn } = await running();
			await fromAssistant(id, turn, delta(`export T=${TOKEN}\n`));
			expect((await snapshotOf(id)).partial_text).toBe(`export T=${SECRET_MASK}\n`);
		});

		it("工具输出里拆开的令牌也一样", async () => {
			const { id, turn } = await running();
			await fromAssistant(id, turn, toolCall("c1"));
			await fromAssistant(id, turn, output("c1", "TOKEN=sfly_ses_0123456789abcdef"));
			await fromAssistant(id, turn, output("c1", "0011223344556677889900aabbccddeeff\n"));
			expect((await snapshotOf(id)).running_tool?.output).toBe(`TOKEN=${SECRET_MASK}\n`);
		});

		it("令牌跨在输出的截断边界上：令牌离结尾多远，最后一段里都没有原值，也没有半截", async () => {
			const { id, turn } = await running();
			await fromAssistant(id, turn, toolCall("c1"));
			const leaks = (text: string) =>
				Array.from({ length: HEX.length - 7 }, (_, i) => HEX.slice(i, i + 8)).some((part) =>
					text.includes(part),
				);
			// 先放令牌（前面是够多的填充，窗口已经削过），再一点一点往后加填充：令牌离结尾的距离扫过「最后 LIMIT 个字节」的边界
			// 和窗口（再多留 1 KB）的边界，两处各前后 60 个字符。
			await fromAssistant(id, turn, output("c1", `${".".repeat(LIMIT * 3)}${TOKEN}`));
			const targets = new Set<number>();
			for (const edge of [LIMIT, LIMIT + 1024]) {
				for (let d = -60; d <= 60; d++) targets.add(edge + d);
			}
			let tail = 0;
			for (const target of [...targets].sort((x, y) => x - y)) {
				await fromAssistant(id, turn, output("c1", ".".repeat(target - tail)));
				tail = target;
				const out = (await snapshotOf(id)).running_tool?.output ?? "";
				expect(leaks(out), `令牌离结尾 ${tail} 个字符`).toBe(false);
				expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(LIMIT);
			}
		}, 120_000);
	});

	describe("排队的位置和在等谁", () => {
		it("项目里有会话在做：排队的会话的快照写排第几、在等谁（正在做的那个），状态是排队中", async () => {
			const project = await newProject();
			const first = await newSession(project, "idle", "在做的事");
			const begun = await store.beginTurn(first.id, project, opening);
			expect(begun.outcome).toBe("started");
			// 排队的先后按排队的时刻（同一时刻的按 ID）：手动时钟走一秒，两个会话的先后才固定。
			const second = await newSession(project, "queued");
			clock.advance(1_000);
			const third = await newSession(project, "queued");
			expect(await snapshotOf(second.id)).toMatchObject({
				status: "queued",
				queue_position: 1,
				waiting_for: { session_id: first.id, title: "在做的事", created_by: "alice" },
			});
			expect(await snapshotOf(third.id)).toMatchObject({ status: "queued", queue_position: 2 });
		});

		it("项目里没有会话在做：排队的会话在等助手服务或工作台恢复，在等谁是 null，位置仍有", async () => {
			const project = await newProject();
			const queued = await newSession(project, "queued");
			expect(await snapshotOf(queued.id)).toMatchObject({
				status: "queued",
				queue_position: 1,
				waiting_for: null,
			});
		});

		it("没有排队时位置和在等谁都是 null", async () => {
			const { id } = await running();
			expect(await snapshotOf(id)).toMatchObject({ queue_position: null, waiting_for: null });
		});

		it("停止途中说了话、排在这一轮后面的在做的会话：状态仍是在做，有位置，在等的是自己正在停止的这一轮", async () => {
			const { id } = await running();
			const behind = await store.queueBehind(id, { ...opening, message_id: messageId(4) });
			expect(behind.queued).toBe(true);
			expect(await snapshotOf(id)).toMatchObject({
				status: "running",
				queue_position: 1,
				waiting_for: { session_id: id },
			});
		});
	});
});
