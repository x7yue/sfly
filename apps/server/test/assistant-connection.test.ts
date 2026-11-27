// 控制面和助手服务的事件连接（src/sessions/assistant-client.ts 的 events、assistant-connection.ts）：
// - 心跳：协议里事件流每 15 秒一行心跳；控制面超过若干个间隔没收到任何字节就当连接死了、主动断开（不等响应体超时 300 秒）；
// - 过滤：助手服务发来的每一条事件落库或发布之前核对会话在做、记录的 turn 是此刻在做的那一轮；只该由控制面产生的事件类型不收。
// 不起 HTTP 服务：客户端用假的 fetch（一条能按需推行、静默、被中止的流），连接用真的 SessionStore 和真的数据库。
import { randomUUID } from "node:crypto";
import {
	ASSISTANT_STREAM_HEARTBEAT_MS,
	ASSISTANT_STREAM_IDLE_INTERVALS,
	AssistantStreamLine,
	type AssistantStreamRecord,
	type SessionEvent,
} from "@sfly/schema";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/db/database.js";
import type { ProjectId } from "../src/projects/project-id.js";
import {
	ASSISTANT_REJECTION_TEXT,
	AssistantClient,
	AssistantUnreachableError,
	describeSkippedLine,
	FETCH_BODY_TIMEOUT_MS,
	MAX_REJECTION_DETAIL_CHARS,
	outcomeUnknown,
	reasonOf,
} from "../src/sessions/assistant-client.js";
import { AssistantConnection } from "../src/sessions/assistant-connection.js";
import { SessionService } from "../src/sessions/session-service.js";
import { SessionNotFoundError, SessionStore } from "../src/sessions/session-store.js";
import { TestAccounts } from "./support/credentials.js";
import { eventually } from "./support/eventually.js";
import { ManualClock } from "./support/manual-clock.js";
import { messageId } from "./support/sessions.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

const config = { url: new URL("http://assistant.test"), secret: "x".repeat(32) };

/** 假的 fetch：返回一条 NDJSON 流；`start` 拿到「推一行」「关流」；请求被中止时流报错（和真的一样）。 */
function streamFetch(
	start: (push: (line: string) => void, close: () => void) => void,
): typeof fetch {
	return (async (_url: unknown, init?: RequestInit) => {
		const signal = init?.signal as AbortSignal;
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				start(
					(line) => controller.enqueue(encoder.encode(`${line}\n`)),
					() => controller.close(),
				);
				signal.addEventListener(
					"abort",
					() => controller.error(new DOMException("aborted", "AbortError")),
					{ once: true },
				);
			},
		});
		return new Response(body, { status: 200 });
	}) as typeof fetch;
}

/** 读事件流直到结束，收下每一行和被跳过的原因。 */
async function drain(client: AssistantClient, signal: AbortSignal) {
	const lines: AssistantStreamLine[] = [];
	const skipped: string[] = [];
	try {
		for await (const line of client.events(signal, (reason) => skipped.push(reason)))
			lines.push(line);
	} catch (error) {
		return { lines, skipped, error };
	}
	return { lines, skipped, error: undefined };
}

const hello = JSON.stringify({ type: "hello", epoch: "e1", gap: false });
const heartbeat = JSON.stringify({ type: "heartbeat" });

describe("事件流：心跳和死连接检测", () => {
	it("协议里有心跳：每 15 秒一行 {type: heartbeat}，控制面超过 3 个间隔没收到任何东西才当连接死了；心跳行能过 schema", () => {
		expect(ASSISTANT_STREAM_HEARTBEAT_MS).toBe(15_000);
		expect(ASSISTANT_STREAM_IDLE_INTERVALS).toBe(3);
		expect(AssistantStreamLine.parse({ type: "heartbeat" })).toEqual({ type: "heartbeat" });
		// 多余的字段被剥掉，别的 type 不认。
		expect(AssistantStreamLine.safeParse({ type: "ping" }).success).toBe(false);
	});

	it("默认的空闲上限（3 个心跳间隔）远小于 fetch 的响应体超时：先触发的总是控制面自己的检测；设得比它长的构造时就拒绝", () => {
		expect(ASSISTANT_STREAM_HEARTBEAT_MS * ASSISTANT_STREAM_IDLE_INTERVALS).toBeLessThan(
			FETCH_BODY_TIMEOUT_MS,
		);
		expect(() => new AssistantClient(config)).not.toThrow();
		expect(() => new AssistantClient(config, { eventsIdleMs: FETCH_BODY_TIMEOUT_MS })).toThrow(
			RangeError,
		);
	});

	it("心跳行和 hello 都交给调用方（它们都有 type，连接跳过）", async () => {
		const client = new AssistantClient(config, {
			fetch: streamFetch((push, close) => {
				push(hello);
				push(heartbeat);
				close();
			}),
		});
		const { lines, skipped, error } = await drain(client, new AbortController().signal);
		expect(error).toBeUndefined();
		expect(skipped).toEqual([]);
		expect(lines).toEqual([{ type: "hello", epoch: "e1", gap: false }, { type: "heartbeat" }]);
	});

	it("静默超过阈值：主动断开，抛 AssistantUnreachableError，说明里写明是没有收到任何内容（不等响应体超时）", async () => {
		const client = new AssistantClient(config, {
			eventsIdleMs: 120,
			fetch: streamFetch((push) => push(hello)),
		});
		const started = Date.now();
		const { lines, error } = await drain(client, new AbortController().signal);
		expect(lines).toHaveLength(1);
		expect(error).toBeInstanceOf(AssistantUnreachableError);
		expect((error as Error).message).toContain("没有收到任何内容");
		expect((error as Error).message).toContain("心跳也没有");
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it("连接没建起来（请求挂住）也算：超过阈值抛 AssistantUnreachableError", async () => {
		const hanging = (async (_url: unknown, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				(init?.signal as AbortSignal).addEventListener("abort", () =>
					reject(new DOMException("aborted", "AbortError")),
				);
			})) as typeof fetch;
		const client = new AssistantClient(config, { eventsIdleMs: 100, fetch: hanging });
		const { error } = await drain(client, new AbortController().signal);
		expect(error).toBeInstanceOf(AssistantUnreachableError);
		expect((error as Error).message).toContain("没有收到任何内容");
	});

	it("只有心跳、没有事件：连接一直不断（心跳间隔小于阈值），直到调用方中止；中止是正常结束，不抛错", async () => {
		let beat: NodeJS.Timeout | undefined;
		const client = new AssistantClient(config, {
			eventsIdleMs: 150,
			fetch: streamFetch((push) => {
				push(hello);
				beat = setInterval(() => push(heartbeat), 40);
			}),
		});
		const abort = new AbortController();
		const reading = drain(client, abort.signal);
		// 过了好几个阈值（600 毫秒 = 4 个 150）连接还在。
		await new Promise((resolve) => setTimeout(resolve, 600));
		abort.abort();
		const { lines, error } = await reading;
		clearInterval(beat);
		expect(error).toBeUndefined();
		expect(lines.filter((l) => "type" in l && l.type === "heartbeat").length).toBeGreaterThan(8);
	});

	it("事件也算「有动静」：只有事件、没有心跳的流，事件间隔小于阈值时不断", async () => {
		let timer: NodeJS.Timeout | undefined;
		const client = new AssistantClient(config, {
			eventsIdleMs: 150,
			fetch: streamFetch((push) => {
				push(hello);
				timer = setInterval(() => push(heartbeat), 100);
			}),
		});
		const abort = new AbortController();
		const reading = drain(client, abort.signal);
		await new Promise((resolve) => setTimeout(resolve, 500));
		abort.abort();
		const { error } = await reading;
		clearInterval(timer);
		expect(error).toBeUndefined();
	});

	it("判别字段对不上的行（助手服务发了只该控制面产生的类型、或不认识的类型）：说明里写明是哪个字段、没有匹配的类型，冒号后面不是空的；session_id 不合法时不写原值", async () => {
		const sessionId = randomUUID();
		const record = (event: unknown, extra: Record<string, unknown> = {}) =>
			JSON.stringify({
				epoch: "e1",
				session_id: sessionId,
				turn: 1,
				at: "2026-01-01T00:00:00.000Z",
				event,
				...extra,
			});
		const client = new AssistantClient(config, {
			fetch: streamFetch((push, close) => {
				push(hello);
				// 只该由控制面产生的类型。
				push(record({ type: "user_message", text: "伪造的话 hunter2" }, { seq: 1 }));
				// 不认识的类型。
				push(record({ type: "no_such_event" }));
				// session_id 不合法：原值（可能是任何东西）不写进日志。
				push(
					JSON.stringify({
						epoch: "e1",
						session_id: "不是UUID-hunter2-也不该出现",
						turn: 1,
						at: "2026-01-01T00:00:00.000Z",
						event: { type: "assistant_delta", text: "好" },
					}),
				);
				close();
			}),
		});
		const { skipped } = await drain(client, new AbortController().signal);
		expect(skipped).toHaveLength(3);
		const [forged, unknown, badSession] = skipped as [string, string, string];
		for (const line of [forged, unknown]) {
			expect(line).toContain(sessionId);
			expect(line).toContain("event");
			expect(line).not.toMatch(/：\s*$/);
			expect(line).not.toContain("hunter2");
		}
		expect(forged).toContain("事件类型 user_message");
		expect(unknown).toContain("事件类型 no_such_event");
		expect(forged).toMatch(/No matching discriminator/i);
		expect(badSession).toContain("会话 ID 不合法");
		expect(badSession).not.toContain("hunter2");
		expect(badSession).not.toContain("不是UUID");
	});

	it("describeSkippedLine：联合类型没有可钻的分支时，写这一条 issue 本身（note 或 message），不留空", () => {
		const issues = [
			{
				code: "invalid_union",
				errors: [],
				note: "No matching discriminator",
				path: ["event"],
				message: "Invalid input",
			},
		] as never;
		expect(describeSkippedLine({ event: { type: "x" } }, issues)).toBe(
			"事件类型 x：event: No matching discriminator",
		);
		const noNote = [
			{ code: "invalid_union", errors: [], path: [], message: "Invalid input" },
		] as never;
		expect(describeSkippedLine({}, noNote)).toBe("Invalid input");
	});

	it("调用方处理得慢不算连接死了：对端一直在写，单行处理超过空闲上限也不断；处理完之后对端不再写，照样被发现", async () => {
		let beat: NodeJS.Timeout | undefined;
		const client = new AssistantClient(config, {
			eventsIdleMs: 150,
			fetch: streamFetch((push) => {
				push(hello);
				beat = setInterval(() => push(heartbeat), 30);
			}),
		});
		const seen: string[] = [];
		let slowed = false;
		const reading = (async () => {
			try {
				for await (const line of client.events(new AbortController().signal, () => {})) {
					seen.push("type" in line ? line.type : "record");
					if (!slowed) {
						slowed = true;
						// 处理这一行比空闲上限（150 毫秒）慢得多：这段时间对端一直在写，不算「没有收到字节」。
						await new Promise((resolve) => setTimeout(resolve, 500));
					}
				}
			} catch (error) {
				return error;
			}
			return undefined;
		})();
		await new Promise((resolve) => setTimeout(resolve, 900));
		// 处理完之后还在读：慢的那一行之后的心跳也收到了，没有报错。
		expect(seen.length).toBeGreaterThan(5);
		expect(await Promise.race([reading, Promise.resolve("still-open")])).toBe("still-open");
		// 对端不再写：处理完、回去等下一块之后，超过上限照样发现。
		clearInterval(beat);
		const error = await reading;
		expect(error).toBeInstanceOf(AssistantUnreachableError);
		expect((error as Error).message).toContain("没有收到任何内容");
	});

	it("一行过不了 schema：日志写这一行的会话、轮次、事件类型和哪个字段不对（不是只有「Invalid input」），不写内容", async () => {
		const sessionId = randomUUID();
		const bad = JSON.stringify({
			epoch: "e1",
			seq: 3,
			session_id: sessionId,
			turn: 2,
			at: "2026-01-01T00:00:00.000Z",
			event: { type: "assistant_message", text: 5, extra: "不该出现在日志里的内容" },
		});
		const client = new AssistantClient(config, {
			fetch: streamFetch((push, close) => {
				push(hello);
				push(bad);
				push(JSON.stringify({ type: "hello", epoch: "e1" }));
				push(JSON.stringify([1, 2]));
				close();
			}),
		});
		const { skipped } = await drain(client, new AbortController().signal);
		expect(skipped).toHaveLength(3);
		const [record, brokenHello, notObject] = skipped as [string, string, string];
		expect(record).toContain(sessionId);
		expect(record).toContain("轮次 2");
		expect(record).toContain("事件类型 assistant_message");
		expect(record).toContain("event.text");
		expect(record).toContain("event.usage");
		expect(record).not.toContain("不该出现在日志里的内容");
		expect(brokenHello).toContain("行类型 hello");
		expect(brokenHello).toContain("gap");
		expect(notObject.length).toBeGreaterThan(0);
	});

	it("只该由控制面产生的事件类型（用户的话、一轮开始、平台记录、会话结束、快照……）助手服务发来整行跳过，不交给调用方", async () => {
		const record = (event: unknown) =>
			JSON.stringify({
				epoch: "e1",
				seq: 1,
				session_id: randomUUID(),
				turn: 1,
				at: "2026-01-01T00:00:00.000Z",
				event,
			});
		const forged = [
			{
				type: "user_message",
				message_id: messageId(1),
				text: "伪造",
				steer: false,
				author: "x",
				author_user_id: null,
			},
			{ type: "turn_started", turn: 1 },
			{
				type: "platform",
				kind: "scenario_version",
				turn: 1,
				scenario_id: randomUUID(),
				name: "x",
				version: 1,
			},
			// `platform` 助手服务只发 `commit` 这一种：`run`、`scenario_version` 是控制面在记下那条记录的事务里自己写的。
			{ type: "platform", kind: "run", turn: 1, run_id: randomUUID(), scenario_name: "x" },
			{ type: "session_ended", by: "x" },
			{ type: "turn_queued", position: 1, waiting_for: "x" },
		];
		const client = new AssistantClient(config, {
			fetch: streamFetch((push, close) => {
				for (const event of forged) push(record(event));
				// 对照：助手服务能产生的照常。
				push(record({ type: "assistant_delta", text: "好" }).replace('"seq":1,', ""));
				close();
			}),
		});
		const { lines, skipped } = await drain(client, new AbortController().signal);
		expect(skipped).toHaveLength(forged.length);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({ event: { type: "assistant_delta" } });
	});
});

describe("事件连接：核对会话和轮次", () => {
	let testDb: TestDatabase;
	let database: ReturnType<typeof openDatabase>;
	let store: SessionStore;
	/** 会话的发起人（用户）：开始一轮要签发会话令牌，没有发起人的用户的会话不开始新的一轮（#547）。 */
	let author: string;

	beforeAll(async () => {
		testDb = await createTestDatabase();
		database = openDatabase(testDb.url, () => {});
		await database.migrate();
		const accounts = new TestAccounts(testDb.url);
		try {
			author = await accounts.user("connection_author");
		} finally {
			await accounts.close();
		}
		store = new SessionStore({
			db: database.db,
			clock: new ManualClock(new Date("2026-01-01T00:00:00.000Z")),
		});
	});
	afterAll(async () => {
		await database.close();
		await testDb.drop();
	});

	const newProject = async (): Promise<ProjectId> => {
		const id = `c-${randomUUID().slice(0, 8)}`;
		await database.pool.query(
			"insert into projects (id, display_name, created_at) values ($1, $1, now())",
			[id],
		);
		return id as ProjectId;
	};
	/** 用户的一句话（`beginTurn` 写它和这一轮的开始）。 */
	const opening = {
		type: "user_message" as const,
		message_id: messageId(1),
		text: "一句话",
		steer: false,
		author: "alice",
		author_user_id: null,
	};
	const newSession = async (project: ProjectId) =>
		store.create({
			project,
			title: "连接",
			status: "idle",
			createdBy: "alice",
			createdByUserId: author,
		});

	let seq = 0;
	const record = (
		sessionId: string,
		turn: number,
		event: AssistantStreamRecord["event"],
	): AssistantStreamRecord =>
		({
			epoch: "e1",
			...("text" in event && event.type === "assistant_delta" ? {} : { seq: ++seq }),
			session_id: sessionId,
			turn,
			at: "2026-01-01T00:00:00.000Z",
			event,
		}) as AssistantStreamRecord;
	const message = (text: string) => ({
		type: "assistant_message" as const,
		text,
		usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 },
	});
	const toolCall = (id: string) => ({
		type: "tool_call" as const,
		call_id: id,
		tool: "command" as const,
		title: "ls",
	});
	const toolResult = (id: string) => ({
		type: "tool_result" as const,
		call_id: id,
		is_error: false,
		text: "ok",
		truncated: false,
		exit_code: 0,
		duration_ms: 1,
	});
	const delta = (text: string) => ({ type: "assistant_delta" as const, text });
	const turnEnd = (turn: number) => ({
		type: "turn_end" as const,
		turn,
		outcome: "completed" as const,
		reason: "助手已完成",
		duration_ms: 1,
	});

	/** 把这些记录依次交给连接，等它们处理完；返回日志。 */
	async function run(records: AssistantStreamRecord[]): Promise<string[]> {
		const logs: string[] = [];
		let handled = 0;
		const client = {
			async *events(signal: AbortSignal) {
				for (const r of records) {
					yield r;
					handled += 1;
				}
				// 流不结束：连接停在这里，等被关掉（结束会触发重连，重复处理）。
				await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
			},
		} as unknown as AssistantClient;
		const connection = new AssistantConnection({
			client,
			sessions: store,
			log: (text) => logs.push(text),
			reconnect: { minMs: 10, maxMs: 10 },
		});
		connection.start();
		await eventually(() => expect(handled).toBe(records.length), 5000);
		// 最后一条的处理（落库）还在进行：再等一会儿。
		await new Promise((resolve) => setTimeout(resolve, 150));
		await connection.close();
		return logs;
	}

	const collect = (sessionId: string) => {
		const out: SessionEvent[] = [];
		const stop = store.follow(
			sessionId,
			0,
			// 补发读完切到实时的那一刻发的快照（#545）不算：这些用例看的是推给浏览器的事件有没有、对不对。
			{
				emit: (e) => {
					if (e.type !== "snapshot") out.push(e);
				},
				drained: () => Promise.resolve(),
			},
			(error) => {
				throw error;
			},
		);
		return { out, stop };
	};
	const types = async (id: string) => (await store.after(id, 0, 100)).map((e) => e.type);

	it("停止之后开始第 2 轮，第 1 轮迟到的消息、工具调用和结果、增量都不落库、不推给浏览器，第 2 轮的状态不变", async () => {
		const project = await newProject();
		const { id } = await newSession(project);
		await store.beginTurn(id, project, opening);
		// 控制面补了第 1 轮的结局（停止），用户接着开始第 2 轮。
		await store.append(id, {
			type: "turn_end",
			turn: 1,
			outcome: "stopped",
			reason: "用户停止",
			duration_ms: 1,
		});
		await store.beginTurn(id, project, opening);
		const before = await types(id);
		const { out, stop } = collect(id);
		const logs = await run([
			record(id, 1, delta("迟到的增量")),
			record(id, 1, message("迟到的消息")),
			record(id, 1, toolCall("c1")),
			record(id, 1, toolResult("c1")),
			record(id, 1, turnEnd(1)),
			// 第 2 轮自己的事件照常。
			record(id, 2, message("第 2 轮的消息")),
		]);
		expect(await types(id)).toEqual([...before, "assistant_message"]);
		expect((await store.after(id, 0, 100)).at(-1)).toMatchObject({ text: "第 2 轮的消息" });
		expect(await store.find(id)).toMatchObject({ status: "running", currentTurn: 2 });
		// 浏览器那边：只有第 2 轮的那条消息（迟到的增量没有推给它）。
		await eventually(() => expect(out.some((e) => e.type === "assistant_message")).toBe(true));
		expect(out.filter((e) => e.type === "assistant_delta")).toEqual([]);
		stop();
		// 日志：写明丢了什么（会话、轮次、类型、原因），不含内容。
		const joined = logs.join("\n");
		expect(joined).toContain(id);
		expect(joined).toContain("轮次 1");
		for (const type of [
			"assistant_message",
			"tool_call",
			"tool_result",
			"turn_end",
			"assistant_delta",
		]) {
			expect(joined, type).toContain(type);
		}
		expect(joined).toContain("不是会话此刻在做的那一轮");
		expect(joined).not.toContain("迟到的消息");
		expect(joined).not.toContain("迟到的增量");
	});

	it("助手服务发来的 platform（commit）事件：落库（时间是助手服务盖的）、排在这一轮的 turn_end 前面、推给浏览器；被打断那一轮的补提交带上一轮的轮次、在这一轮的事件流里照样收下", async () => {
		const project = await newProject();
		const { id } = await newSession(project);
		await store.beginTurn(id, project, opening);
		const commit = (turn: number, hash: string) => ({
			type: "platform" as const,
			kind: "commit" as const,
			turn,
			hash,
			files: [
				{ path: "a.txt", additions: 1, deletions: 0 },
				{ path: "logo.png", additions: null, deletions: null },
			],
			diff: "diff --git a/a.txt b/a.txt\n+x\n",
			truncated: true,
		});
		const { out, stop } = collect(id);
		const first = "a".repeat(40);
		const logs = await run([
			{ ...record(id, 1, commit(1, first)), at: "2026-01-01T00:00:07.000Z" },
			record(id, 1, turnEnd(1)),
		]);
		const stored = await store.after(id, 0, 100);
		expect(stored.map((e) => e.type)).toEqual([
			"user_message",
			"turn_started",
			"platform",
			"turn_end",
		]);
		expect(stored[2]).toMatchObject({
			type: "platform",
			kind: "commit",
			turn: 1,
			hash: first,
			files: [
				{ path: "a.txt", additions: 1, deletions: 0 },
				{ path: "logo.png", additions: null, deletions: null },
			],
			diff: "diff --git a/a.txt b/a.txt\n+x\n",
			truncated: true,
			at: "2026-01-01T00:00:07.000Z",
		});
		await eventually(() => expect(out.some((e) => e.type === "platform")).toBe(true));

		// 第 2 轮开始前补提交上一轮（被打断的那一轮）留下的改动：记录的轮次是 2（此刻在做的），事件里的轮次是 1。
		await store.beginTurn(id, project, opening);
		const second = "b".repeat(40);
		logs.push(...(await run([record(id, 2, commit(1, second))])));
		const left = (await store.after(id, 0, 100)).filter(
			(e): e is Extract<typeof e, { kind: "commit" }> =>
				e.type === "platform" && e.kind === "commit",
		);
		expect(left.map((e) => [e.turn, e.hash])).toEqual([
			[1, first],
			[1, second],
		]);
		// 这一轮结束之后（会话空闲）才到的不收，和别的助手事件一样。
		await run([record(id, 2, turnEnd(2)), record(id, 2, commit(2, "c".repeat(40)))]);
		expect((await store.after(id, 0, 100)).filter((e) => e.type === "platform")).toHaveLength(2);
		expect(logs.join("\n")).toBe("");
		stop();
	});

	it("空闲和已结束的会话也不收助手服务的事件：不落库、不推送、不改状态（空闲的会话收到 turn_end 不变）", async () => {
		const project = await newProject();
		const idle = await newSession(project);
		const ended = await newSession(project);
		await database.pool.query("update sessions set status = 'ended' where id = $1", [ended.id]);
		const { out, stop } = collect(idle.id);
		const logs = await run([
			record(idle.id, 9, turnEnd(9)),
			record(idle.id, 1, message("空闲的会话")),
			record(idle.id, 1, delta("空闲的增量")),
			record(ended.id, 1, message("已结束的会话")),
		]);
		expect(await types(idle.id)).toEqual([]);
		expect(await types(ended.id)).toEqual([]);
		expect(await store.find(idle.id)).toMatchObject({ status: "idle", currentTurn: 0 });
		expect(await store.find(ended.id)).toMatchObject({ status: "ended" });
		expect(out).toEqual([]);
		stop();
		expect(logs.join("\n")).toContain("会话不在做");
	});

	it("在做的第 2 轮收到轮次写成 7 的 turn_end：丢掉，会话仍在做；turn_end 的轮次和记录的轮次不一致也丢掉；对的才改回空闲", async () => {
		const project = await newProject();
		const { id } = await newSession(project);
		await store.beginTurn(id, project, opening);
		await store.append(id, {
			type: "turn_end",
			turn: 1,
			outcome: "completed",
			reason: "x",
			duration_ms: 1,
		});
		await store.beginTurn(id, project, opening);
		const logs = await run([
			record(id, 7, turnEnd(7)),
			// 记录的轮次对，但 turn_end 里写的是别的：不一致。
			record(id, 2, turnEnd(3)),
		]);
		expect(await store.find(id)).toMatchObject({ status: "running", currentTurn: 2 });
		expect((await types(id)).filter((t) => t === "turn_end")).toHaveLength(1);
		expect(logs.join("\n")).toContain("turn_end 的轮次和记录的轮次不一致");
		// 对的：第 2 轮的结局。
		await run([record(id, 2, turnEnd(2))]);
		expect((await store.find(id))?.status).toBe("idle");
	});

	it("控制面不认识的会话：丢掉，记日志；增量一类每个（会话、轮次、原因）只记第一条，不刷屏", async () => {
		const unknown = randomUUID();
		const logs = await run([
			record(unknown, 1, message("没有这个会话")),
			record(unknown, 1, delta("一")),
			record(unknown, 1, delta("二")),
			record(unknown, 1, delta("三")),
		]);
		const lines = logs.filter((l) => l.includes(unknown));
		// 持久的一条，不持久的三条合成一条。
		expect(lines).toHaveLength(2);
		expect(lines.every((l) => l.includes("控制面不认识这个会话"))).toBe(true);
	});
});

describe("连不上助手服务的说明：只有原因的种类，不带地址和端口；原文进日志", () => {
	const refused = () =>
		Object.assign(new TypeError("fetch failed"), {
			cause: Object.assign(new Error("connect ECONNREFUSED 10.1.2.3:7000"), {
				code: "ECONNREFUSED",
			}),
		});

	it("reasonOf：按错误码和名字分类，说明里没有地址、端口和底层错误的原文", () => {
		expect(reasonOf(refused())).toBe("连接被拒绝");
		expect(
			reasonOf(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
		).toBe("没有及时回应（超时）");
		expect(
			reasonOf(
				Object.assign(new Error("getaddrinfo ENOTFOUND assistant.internal"), { code: "ENOTFOUND" }),
			),
		).toBe("域名解析不了");
		expect(reasonOf(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))).toBe(
			"连接被对端关闭",
		);
		expect(reasonOf(new Error("留着 10.1.2.3:7000 的什么错误"))).toBe("网络出错");
		expect(reasonOf("不是 Error")).toBe("网络出错");
		for (const error of [refused(), new Error("留着 10.1.2.3:7000 的什么错误")]) {
			expect(reasonOf(error)).not.toMatch(/10\.1\.2\.3|7000/);
		}
	});

	it("命令、/health 连不上：AssistantUnreachableError 的说明是稳定的一句，原错误在 cause 里", async () => {
		const raw = refused();
		const client = new AssistantClient(config, {
			fetch: (async () => {
				throw raw;
			}) as typeof fetch,
		});
		for (const call of [() => client.health(), () => client.abort(randomUUID(), 1)]) {
			const error = await call().catch((e: unknown) => e);
			expect(error).toBeInstanceOf(AssistantUnreachableError);
			expect((error as Error).message).toBe("连不上助手服务：连接被拒绝");
			expect((error as Error).cause).toBe(raw);
		}
	});

	it("中止的请求体是 { turn }：要结束的是第几轮，路径里是会话 ID", async () => {
		const sent: Array<{ url: string; method: string | undefined; body: unknown }> = [];
		const client = new AssistantClient(config, {
			fetch: (async (url: unknown, init?: RequestInit) => {
				sent.push({
					url: String(url),
					method: init?.method,
					body: JSON.parse(String(init?.body)),
				});
				return new Response(null, { status: 202 });
			}) as typeof fetch,
		});
		const sessionId = randomUUID();
		await client.abort(sessionId, 3);
		expect(sent).toEqual([
			{
				url: `http://assistant.test/sessions/${sessionId}/abort`,
				method: "POST",
				body: { turn: 3 },
			},
		]);
	});

	it("助手服务的拒绝：它自己写的那句话进 detail（有长度上限）；回应体不是约定的形状时 detail 不写内容，只写状态码和长度", async () => {
		const reply = (status: number, body: string) =>
			new AssistantClient(config, {
				fetch: (async () => new Response(body, { status })) as typeof fetch,
			});
		// 约定形状、说明很长：截到上限。
		const long = JSON.stringify({ code: "start_failed", message: "x".repeat(5_000) });
		const rejected = (await reply(503, long)
			.abort(randomUUID(), 1)
			.catch((e: unknown) => e)) as {
			message: string;
			detail: string;
			code: string;
		};
		expect(rejected.code).toBe("start_failed");
		expect(rejected.detail).toHaveLength(MAX_REJECTION_DETAIL_CHARS);
		expect(rejected.message).toBe("助手服务起不了这一轮的进程");
		// 不是约定的形状（比如反向代理的 HTML 错误页，可能带着会话的内容）：不写内容。
		const html = "<html>网关错误：我的私密的话 hunter2</html>";
		const odd = (await reply(502, html)
			.abort(randomUUID(), 1)
			.catch((e: unknown) => e)) as {
			message: string;
			detail: string;
		};
		expect(odd.message).toBe("助手服务回应了 502");
		expect(odd.detail).toBe(`回应体不是约定的形状（状态码 502，${html.length} 个字符）`);
		expect(odd.detail).not.toContain("hunter2");
	});

	it("两句固定的说明告诉用户该怎么办：上一轮还在做（先停止再说）、进程数到了上限（等别的会话停下来）", () => {
		expect(ASSISTANT_REJECTION_TEXT.turn_running).toContain("停止");
		expect(ASSISTANT_REJECTION_TEXT.process_limit).toBe(
			"助手服务同时在做的会话太多：等别的会话停下来再试",
		);
	});

	it("命令有没有可能已经送到：只有请求一个字节都没发出去（连接被拒绝、域名解析不了、没有路由、建立连接就超时）才是一定没送到；超时、发出请求之后连接被重置或关闭是未知；认不出的错也是未知", () => {
		const coded = (code: string, extra: Record<string, unknown> = {}) =>
			Object.assign(new TypeError("fetch failed"), {
				cause: Object.assign(new Error(code), { code, ...extra }),
			});
		expect(outcomeUnknown(new DOMException("timeout", "TimeoutError"))).toBe(true);
		for (const code of [
			"ECONNRESET",
			"EPIPE",
			"UND_ERR_SOCKET",
			"UND_ERR_HEADERS_TIMEOUT",
			"UND_ERR_BODY_TIMEOUT",
		]) {
			expect(outcomeUnknown(coded(code)), code).toBe(true);
		}
		for (const code of [
			"ECONNREFUSED",
			"ENOTFOUND",
			"EAI_AGAIN",
			"EHOSTUNREACH",
			"ENETUNREACH",
			"UND_ERR_CONNECT_TIMEOUT",
		]) {
			expect(outcomeUnknown(coded(code)), code).toBe(false);
		}
		// `ETIMEDOUT`：建立连接时（系统调用 connect）是没连上；别的时候（已经连上的连接上重传超时）是发出之后。
		expect(outcomeUnknown(coded("ETIMEDOUT", { syscall: "connect" }))).toBe(false);
		expect(outcomeUnknown(coded("ETIMEDOUT", { syscall: "read" }))).toBe(true);
		expect(outcomeUnknown(coded("ETIMEDOUT"))).toBe(true);
		// 认不出的错落在保守的一边：未知。
		for (const code of [
			"ECONNABORTED",
			"UND_ERR_ABORTED",
			"UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
			"EWHATEVER",
		]) {
			expect(outcomeUnknown(coded(code)), code).toBe(true);
		}
		expect(outcomeUnknown(new Error("没有码的错"))).toBe(true);
		expect(outcomeUnknown("不是 Error")).toBe(true);
		// 同时有「发出之后」的码和「没连上」的码：未知。
		expect(
			outcomeUnknown(
				Object.assign(new TypeError("fetch failed"), {
					cause: Object.assign(new Error("x"), {
						code: "UND_ERR_SOCKET",
						cause: Object.assign(new Error("y"), { code: "ECONNREFUSED" }),
					}),
				}),
			),
		).toBe(true);
	});

	it("命令的 AssistantUnreachableError 带着 outcomeUnknown：超时是 true，连接被拒绝是 false", async () => {
		const timeout = new AssistantClient(config, {
			fetch: (async () => {
				throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
			}) as typeof fetch,
		});
		const refused = new AssistantClient(config, {
			fetch: (async () => {
				throw Object.assign(new TypeError("fetch failed"), {
					cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
				});
			}) as typeof fetch,
		});
		const a = (await timeout
			.abort(randomUUID(), 1)
			.catch((e: unknown) => e)) as AssistantUnreachableError;
		const b = (await refused
			.abort(randomUUID(), 1)
			.catch((e: unknown) => e)) as AssistantUnreachableError;
		expect(a).toBeInstanceOf(AssistantUnreachableError);
		expect(a.outcomeUnknown).toBe(true);
		expect(b.outcomeUnknown).toBe(false);
	});

	it("事件流连不上：同样只有原因的种类，原错误在 cause 里（事件连接的日志打印它）", async () => {
		const raw = refused();
		const client = new AssistantClient(config, {
			fetch: (async () => {
				throw raw;
			}) as typeof fetch,
		});
		const { error } = await drain(client, new AbortController().signal);
		expect(error).toBeInstanceOf(AssistantUnreachableError);
		expect((error as Error).message).toBe("连不上助手服务：连接被拒绝");
		expect((error as Error).cause).toBe(raw);
	});

	it("就绪状态里的说明和写进日志的：说明里没有地址和端口，日志里有原错误", async () => {
		const raw = refused();
		const logs: Array<{ message: string; error: unknown }> = [];
		const client = new AssistantClient(config, {
			fetch: (async () => {
				throw raw;
			}) as typeof fetch,
		});
		const service = new SessionService({
			sessions: { onTurnEnd: () => {} } as never,
			db: undefined as never,
			hub: undefined as never,
			clock: new ManualClock(new Date("2026-01-01T00:00:00.000Z")),
			setup: { configured: true, config },
			client,
			workbench: { get: async () => undefined },
			log: (message, error) => logs.push({ message, error }),
		});
		const readiness = await service.readiness("default" as ProjectId);
		expect(readiness.problems).toContainEqual({
			kind: "assistant_unreachable",
			message: "连不上助手服务：连接被拒绝",
		});
		expect(JSON.stringify(readiness)).not.toMatch(/10\.1\.2\.3|7000/);
		expect(logs).toHaveLength(1);
		expect(logs[0]?.error).toBeInstanceOf(AssistantUnreachableError);
		expect((logs[0]?.error as Error).cause).toBe(raw);
	});

	it("意外的错误（不是连不上、也不是助手服务的拒绝）：说明只有「助手服务出错」，原文只进日志", async () => {
		const logs: unknown[] = [];
		const service = new SessionService({
			sessions: { onTurnEnd: () => {} } as never,
			db: undefined as never,
			hub: undefined as never,
			clock: new ManualClock(new Date("2026-01-01T00:00:00.000Z")),
			setup: { configured: true, config },
			client: {
				health: async () => {
					throw new Error("内部细节 10.1.2.3:7000 password=hunter2");
				},
			} as unknown as AssistantClient,
			workbench: { get: async () => undefined },
			log: (_message, error) => logs.push(error),
		});
		const readiness = await service.readiness("default" as ProjectId);
		expect(readiness.problems).toContainEqual({
			kind: "assistant_unreachable",
			message: "助手服务出错",
		});
		expect(JSON.stringify(readiness)).not.toMatch(/10\.1\.2\.3|hunter2/);
		expect((logs[0] as Error).message).toContain("hunter2");
	});

	it("describeSkippedLine：认得出不是对象的行，也不写内容", () => {
		expect(describeSkippedLine([1, 2], [])).toBe("");
		expect(describeSkippedLine("a string", [])).toBe("");
	});
});

describe("事件连接：连上、纪元变化时的先后、位置（#545，#764 审查）", () => {
	let testDb: TestDatabase;
	let database: ReturnType<typeof openDatabase>;
	let store: SessionStore;
	let author: string;

	beforeAll(async () => {
		testDb = await createTestDatabase();
		database = openDatabase(testDb.url, () => {});
		await database.migrate();
		const accounts = new TestAccounts(testDb.url);
		try {
			author = await accounts.user("connection_order_author");
		} finally {
			await accounts.close();
		}
		store = new SessionStore({
			db: database.db,
			clock: new ManualClock(new Date("2026-01-01T00:00:00.000Z")),
		});
	});
	afterAll(async () => {
		await database.close();
		await testDb.drop();
	});

	const opening = {
		type: "user_message" as const,
		message_id: messageId(1),
		text: "一句话",
		steer: false,
		author: "alice",
		author_user_id: null,
	};
	/** 一个在做第 1 轮的会话。 */
	async function running(): Promise<string> {
		const project = `o-${randomUUID().slice(0, 8)}`;
		await database.pool.query(
			"insert into projects (id, display_name, created_at) values ($1, $1, now())",
			[project],
		);
		const { id } = await store.create({
			project: project as ProjectId,
			title: "先后",
			status: "idle",
			createdBy: "alice",
			createdByUserId: author,
		});
		await store.beginTurn(id, project as ProjectId, opening);
		return id;
	}
	const message = (text: string) => ({
		type: "assistant_message" as const,
		text,
		usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 },
	});
	/** 库里放一条带位置的助手事件（时间由测试给）。 */
	const seed = (id: string, epoch: string, seq: number, at: string) =>
		store.appendFromAssistant(id, 1, message(`${epoch}:${seq}`), new Date(at), { epoch, seq });

	const hello = (epoch: string, gap = false): AssistantStreamLine => ({
		type: "hello",
		epoch,
		gap,
	});
	const rec = (id: string, epoch: string, seq: number): AssistantStreamLine => ({
		epoch,
		seq,
		session_id: id,
		turn: 1,
		at: "2026-03-01T00:00:00.000Z",
		event: message(`${epoch}:${seq}`),
	});

	/**
	 * 一个按剧本回应的假客户端：每次连接依次给下一份剧本（用完了就停在那里等中止），记下每次连接带的 `after`。
	 */
	function scripted(rounds: AssistantStreamLine[][]) {
		const afters: Array<{ epoch: string; seq: number } | undefined> = [];
		const client = {
			async *events(
				signal: AbortSignal,
				_onSkipped: unknown,
				after?: { epoch: string; seq: number },
			) {
				afters.push(after);
				const lines = rounds.shift();
				for (const line of lines ?? []) yield line;
				// 后面还有剧本：这条流结束（连接重连）；没有了：停在这里等中止。
				if (lines !== undefined && rounds.length > 0) return;
				await new Promise<void>((resolve) =>
					signal.addEventListener("abort", () => resolve(), { once: true }),
				);
			},
		} as unknown as AssistantClient;
		return { client, afters };
	}

	it("纪元变了（助手服务重启了）：补结局（`restarted`）发生在标成连着之前，之后才标成连着、调 `connected`（排队的因此不被「事件流没连上」挡到兜底）", async () => {
		const id = await running();
		await seed(id, "e-old", 1, "2026-01-01T00:00:01.000Z");
		const steps: string[] = [];
		let connection: AssistantConnection | undefined;
		const { client } = scripted([[hello("e-new")]]);
		connection = new AssistantConnection({
			client,
			sessions: store,
			log: () => {},
			reconnect: { minMs: 10, maxMs: 10 },
			recovery: {
				restarted: async (candidates) => {
					steps.push(`restarted（连着：${connection?.connected}，候选：${candidates?.get(id)}）`);
				},
				eventsLost: async () => {
					steps.push("eventsLost");
				},
				connected: async () => {
					steps.push(`connected（连着：${connection?.connected}）`);
				},
			},
		});
		connection.start();
		try {
			await eventually(() => expect(steps).toHaveLength(2), 5000);
			expect(steps).toEqual(["restarted（连着：false，候选：1）", "connected（连着：true）"]);
		} finally {
			await connection.close();
		}
	});

	it("每次 hello 处理完都调 connected（第一次连、断线重连、没有缺口的重连）；hello 没处理完（出错）时不标成连着", async () => {
		const id = await running();
		await seed(id, "e-same", 1, "2026-01-02T00:00:01.000Z");
		let calls = 0;
		const { client, afters } = scripted([[hello("e-same")], [hello("e-same")]]);
		const connection = new AssistantConnection({
			client,
			sessions: store,
			log: () => {},
			reconnect: { minMs: 10, maxMs: 10 },
			recovery: {
				restarted: async () => {},
				eventsLost: async () => {},
				connected: async () => {
					calls++;
				},
			},
		});
		connection.start();
		try {
			await eventually(() => expect(calls).toBeGreaterThanOrEqual(2), 5000);
			expect(afters[0]).toEqual({ epoch: "e-same", seq: 1 });
		} finally {
			await connection.close();
		}
		// 补结局出错（`restarted` 抛错）：这次 hello 没处理完，不标成连着、不调 connected。
		const other = await running();
		await seed(other, "e-a", 1, "2026-01-03T00:10:00.000Z");
		let connectedCalls = 0;
		const failing = scripted([[hello("e-b")]]);
		const bad = new AssistantConnection({
			client: failing.client,
			sessions: store,
			log: () => {},
			reconnect: { minMs: 10, maxMs: 10 },
			recovery: {
				restarted: async () => {
					throw new Error("补结局失败");
				},
				eventsLost: async () => {},
				connected: async () => {
					connectedCalls++;
				},
			},
		});
		bad.start();
		try {
			await eventually(() => expect(failing.afters.length).toBeGreaterThan(0));
			await new Promise((resolve) => setTimeout(resolve, 80));
			expect(bad.connected).toBe(false);
			expect(connectedCalls).toBe(0);
		} finally {
			await bad.close();
		}
	});

	it("记着的位置找错了（时钟偏差：旧纪元的事件时间更晚），hello 的纪元库里已经有事件：不当成助手服务重启，改用库里这个纪元的最大序号重连", async () => {
		const id = await running();
		// 旧纪元的最后一条事件时间更晚（新的助手服务时钟慢了 5 分钟）；新纪元在库里有序号 3。
		await seed(id, "e-1", 2, "2026-06-01T00:10:01.000Z");
		await seed(id, "e-2", 3, "2026-06-01T00:05:00.000Z");
		expect(await store.lastAssistantSource()).toEqual({ epoch: "e-1", seq: 2 });
		expect(await store.lastSeqOfEpoch("e-2")).toBe(3);
		expect(await store.lastSeqOfEpoch("没有这个纪元")).toBeUndefined();
		const restarted: unknown[] = [];
		let connectedCalls = 0;
		const { client, afters } = scripted([[hello("e-2", true)], [hello("e-2"), rec(id, "e-2", 4)]]);
		const connection = new AssistantConnection({
			client,
			sessions: store,
			log: () => {},
			reconnect: { minMs: 10, maxMs: 10 },
			recovery: {
				restarted: async (candidates) => {
					restarted.push(candidates);
				},
				eventsLost: async () => {},
				connected: async () => {
					connectedCalls++;
				},
			},
		});
		connection.start();
		try {
			await eventually(() => expect(connectedCalls).toBe(1), 5000);
			// 第一次带的是找错的旧纪元，第二次带的是库里新纪元的最大序号；没有当成重启；补回来的第 4 条存下了。
			expect(afters).toEqual([
				{ epoch: "e-1", seq: 2 },
				{ epoch: "e-2", seq: 3 },
			]);
			expect(restarted).toEqual([]);
			await eventually(async () => expect(await store.lastSeqOfEpoch("e-2")).toBe(4));
			expect((await store.find(id))?.status).toBe("running");
		} finally {
			await connection.close();
		}
	});

	it("落库时发现会话不存在（SessionNotFoundError）：丢弃也算处理过，位置推进到这一条（重连不再补发、不记第二遍日志）", async () => {
		const id = await running();
		await seed(id, "e-n", 1, "2026-07-01T00:00:01.000Z");
		const spy = vi
			.spyOn(store, "appendFromAssistant")
			.mockRejectedValue(new SessionNotFoundError(id));
		const logs: string[] = [];
		const { client, afters } = scripted([[hello("e-n"), rec(id, "e-n", 7)], [hello("e-n")]]);
		const connection = new AssistantConnection({
			client,
			sessions: store,
			log: (message) => logs.push(message),
			reconnect: { minMs: 10, maxMs: 10 },
		});
		connection.start();
		try {
			await eventually(() => expect(afters.length).toBeGreaterThanOrEqual(2), 5000);
			expect(afters[1]).toEqual({ epoch: "e-n", seq: 7 });
		} finally {
			spy.mockRestore();
			await connection.close();
		}
	});
});
