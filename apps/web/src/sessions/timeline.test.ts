import { SESSION_EVENT_LIMITS, type SessionEvent } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	applyEvent,
	applyQueuedView,
	emptyTimeline,
	hasBehind,
	initialTimeline,
	lastBytes,
	prependHistory,
	type TimelineState,
} from "./timeline";

const USAGE = { input: 1, output: 1, cache_read: 0, cache_write: 0 };
const MSG = (n: number) => `5d1c0a7e-3b2f-4c68-9a41-00000000000${n}`;
let clock = 0;
/** 持久事件的 `at`：每条晚一秒。 */
const at = () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString();

const user = (seq: number, text = "给 http_check 加超时"): SessionEvent => ({
	type: "user_message",
	seq,
	at: at(),
	message_id: MSG(seq % 10),
	text,
	steer: false,
	author: "alice",
	author_user_id: null,
});
const started = (seq: number, turn = 1): SessionEvent => ({
	type: "turn_started",
	seq,
	at: at(),
	turn,
});
const delta = (text: string): SessionEvent => ({ type: "assistant_delta", text });
const message = (seq: number, text: string): SessionEvent => ({
	type: "assistant_message",
	seq,
	at: at(),
	text,
	usage: USAGE,
});
const call = (
	seq: number,
	id: string,
	tool: "command" | "edit" | "read" | "write",
	title: string,
) => ({ type: "tool_call", seq, at: at(), call_id: id, tool, title }) satisfies SessionEvent;
const result = (
	seq: number,
	id: string,
	extra: Partial<Extract<SessionEvent, { type: "tool_result" }>> = {},
): SessionEvent => ({
	type: "tool_result",
	seq,
	at: at(),
	call_id: id,
	is_error: false,
	text: "ok\n",
	truncated: false,
	duration_ms: 420,
	...extra,
});
const end = (
	seq: number,
	outcome: "completed" | "stopped" | "limit" | "model_unavailable" | "interrupted" | "failed",
	extra: Partial<Extract<SessionEvent, { type: "turn_end" }>> = {},
): SessionEvent => ({
	type: "turn_end",
	seq,
	at: at(),
	turn: 1,
	outcome,
	reason: "",
	duration_ms: 84_000,
	...extra,
});

/** 从会话在做（一轮在进行）开始：模型的思考和文字增量只在一轮进行时处理。 */
const run = (events: SessionEvent[], from: TimelineState = emptyTimeline("running")) =>
	events.reduce(applyEvent, from);

describe("会话时间线：由事件序列算出", () => {
	it("用户的话一行，作者和文字原样；一轮开始会话在做", () => {
		const state = run([user(1), started(2)]);
		expect(state.items).toEqual([
			{
				kind: "user",
				key: "e1",
				seq: 1,
				at: expect.any(String),
				messageId: MSG(1),
				author: "alice",
				text: "给 http_check 加超时",
				role: "turn",
				delivery: null,
				droppedNote: null,
				queuedSeen: false,
			},
		]);
		expect(state.status).toBe("running");
		expect(state.lastSeq).toBe(2);
	});

	it("增量逐条追加到同一条助手的话里；之后的整条消息替换拼出来的文字，以它为准", () => {
		let state = run([user(1), started(2), delta("我先看"), delta("一下现有的"), delta("节点。")]);
		expect(state.items.at(-1)).toMatchObject({
			kind: "assistant",
			text: "我先看一下现有的节点。",
			streaming: true,
			seq: null,
		});
		const key = state.items.at(-1)?.key;
		state = applyEvent(state, message(3, "我先看一下现有的节点吧。"));
		expect(state.items.filter((i) => i.kind === "assistant")).toEqual([
			{ kind: "assistant", key, seq: 3, text: "我先看一下现有的节点吧。", streaming: false },
		]);
		expect(state.streamingKey).toBeNull();
	});

	it("没有增量、直接来整条消息（刷新后读历史）：就是一条；空的整条消息不留空行", () => {
		const state = run([message(1, "好的。"), message(2, "   ")]);
		expect(state.items).toEqual([
			{ kind: "assistant", key: "e1", seq: 1, text: "好的。", streaming: false },
		]);
		// 逐字出现之后整条消息是空的（只调用了工具）：把逐字拼的那一条也拿掉。
		const tooled = run([delta("正在"), message(3, "")]);
		expect(tooled.items).toEqual([]);
	});

	it("思考中：有文字或工具出来就去掉；思考的内容不显示", () => {
		let state = run([{ type: "thinking" }]);
		expect(state.thinking).toBe(true);
		expect(state.items).toEqual([]);
		state = applyEvent(state, delta("你好"));
		expect(state.thinking).toBe(false);
		state = run([{ type: "thinking" }, call(1, "c", "command", "ls")]);
		expect(state.thinking).toBe(false);
	});

	it("tool_call 之后同一个 call_id 的 tool_result 落在同一行：命令带退出码和用时", () => {
		const state = run([
			call(1, "c1", "command", "sfly package list"),
			result(2, "c1", { exit_code: 0, text: "http_check 0.3.0\n" }),
		]);
		expect(state.items).toHaveLength(1);
		expect(state.items[0]).toMatchObject({
			kind: "tool",
			callId: "c1",
			tool: "command",
			title: "sfly package list",
			result: {
				isError: false,
				text: "http_check 0.3.0\n",
				exitCode: 0,
				durationMs: 420,
				truncated: false,
			},
			abandoned: false,
		});
	});

	it("工具出错：结果标出错；结果被截断的标 truncated", () => {
		const state = run([
			call(1, "c1", "command", "false"),
			result(2, "c1", { is_error: true, exit_code: 1, text: "boom", truncated: true }),
		]);
		expect(state.items[0]).toMatchObject({
			kind: "tool",
			result: { isError: true, exitCode: 1, truncated: true },
		});
	});

	it("几个工具各占一行，结果按 call_id 对上，不按先后", () => {
		const state = run([
			call(1, "a", "read", "a.py"),
			call(2, "b", "edit", "b.py"),
			result(3, "b", { text: "edited" }),
			result(4, "a", { text: "read a" }),
		]);
		expect(state.items.map((i) => (i.kind === "tool" ? [i.callId, i.result?.text] : null))).toEqual(
			[
				["a", "read a"],
				["b", "edited"],
			],
		);
	});

	it("提示是一行灰字", () => {
		const state = run([
			{ type: "notice", seq: 1, at: at(), kind: "compaction", message: "上下文太长，已经压缩" },
		]);
		expect(state.items).toEqual([
			{
				kind: "notice",
				key: "e1",
				seq: 1,
				noticeKind: "compaction",
				message: "上下文太长，已经压缩",
				messageId: null,
			},
		]);
	});

	it("turn_end 的六种结局各一行，会话回到空闲，没有结果的工具行不再算在做", () => {
		for (const outcome of [
			"completed",
			"stopped",
			"limit",
			"model_unavailable",
			"interrupted",
			"failed",
		] as const) {
			const state = run([
				started(1),
				call(2, "c", "command", "sleep 60"),
				end(3, outcome, { reason: "原因", steps: 2, model_calls: 40, limit_kind: "model_calls" }),
			]);
			expect(state.items.at(-1)).toMatchObject({
				kind: "turn_end",
				outcome,
				seq: 3,
				reason: "原因",
			});
			expect(state.status).toBe("idle");
			expect(state.items.find((i) => i.kind === "tool")).toMatchObject({ abandoned: true });
		}
	});

	it("同一轮只有一个结局：第二个 turn_end 不再画一行，下一轮在做时也不把会话改回空闲", () => {
		const twice = run([started(1), end(2, "completed"), end(3, "failed", { reason: "重复的" })]);
		expect(twice.items.filter((i) => i.kind === "turn_end")).toHaveLength(1);
		expect(twice.items.find((i) => i.kind === "turn_end")).toMatchObject({
			outcome: "completed",
			seq: 2,
		});
		// 序号照常推进（下次补发不会再处理它）。
		expect(twice.lastSeq).toBe(3);

		// 第 2 轮开始之后，第 1 轮迟到的重复结局不动此刻在做的这一轮；第 2 轮自己的结局照常画。
		const secondRunning = run([
			started(1),
			end(2, "completed"),
			user(3, "再来一次"),
			started(4, 2),
			end(5, "stopped", { turn: 1 }),
		]);
		expect(secondRunning.status).toBe("running");
		expect(secondRunning.items.filter((i) => i.kind === "turn_end")).toHaveLength(1);
		const finished = applyEvent(secondRunning, end(6, "completed", { turn: 2 }));
		expect(finished.status).toBe("idle");
		expect(finished.items.filter((i) => i.kind === "turn_end")).toHaveLength(2);
	});

	it("一轮有了结局而调用一直没有结果：这一行是已中止，不转圈；结局之后才到的调用也不转圈", () => {
		// 到了上限、最后一次调用只有调用没有结果：不再算在做。
		const limited = run([
			started(1),
			call(2, "c", "command", "sleep 600"),
			end(3, "limit", { limit_kind: "duration", duration_ms: 1_200_000 }),
		]);
		expect(limited.items.find((i) => i.kind === "tool")).toMatchObject({
			callId: "c",
			result: null,
			abandoned: true,
		});
		// 结局已经画了，这一轮的调用才到（乱序、补发）：一来就是已中止，之后也不会有结果让它转。
		const late = applyEvent(limited, call(4, "late", "command", "ls"));
		expect(late.items.find((i) => i.kind === "tool" && i.callId === "late")).toMatchObject({
			result: null,
			abandoned: true,
		});
		// 会话在做时的调用照常转圈。
		const live = run([started(1), call(2, "now", "command", "ls")]);
		expect(live.items.find((i) => i.kind === "tool")).toMatchObject({ abandoned: false });
	});

	it("turn_end 把还在逐字出现的话定稿", () => {
		const state = run([delta("写到一半"), end(1, "stopped")]);
		expect(state.items[0]).toMatchObject({ kind: "assistant", text: "写到一半", streaming: false });
		expect(state.streamingKey).toBeNull();
	});

	it("同一个序号的持久事件来两次不重复", () => {
		const first = user(1);
		const second = call(2, "c", "command", "ls");
		const once = run([first, second]);
		const twice = run([first, first, second, second]);
		expect(twice).toEqual(once);
		// 序号更小的（重连后补发的旧事件）也不再处理，状态原样返回。
		expect(applyEvent(once, first)).toBe(once);
		// 同一个 call_id 的调用第二次来（序号不同）也不另起一行。
		const again = applyEvent(once, call(3, "c", "command", "ls"));
		expect(again.items.filter((i) => i.kind === "tool")).toHaveLength(1);
	});

	it("一轮结束之后才到的思考和文字增量（补发历史期间到达的、乱序的）不让「思考中」挂着，也不另起一条助手的话", () => {
		const ended = run([started(1), call(2, "c", "command", "ls"), end(3, "completed")]);
		expect(ended.status).toBe("idle");
		const lateThinking = applyEvent(ended, { type: "thinking" });
		expect(lateThinking.thinking).toBe(false);
		expect(lateThinking).toBe(ended);
		const lateDelta = applyEvent(ended, delta("迟到的字"));
		expect(lateDelta.items).toEqual(ended.items);
		expect(lateDelta.streamingKey).toBeNull();
		// 会话已结束之后同样。
		const sessionEnded = run([{ type: "session_ended", seq: 1, at: at(), by: "alice" }]);
		expect(applyEvent(sessionEnded, { type: "thinking" }).thinking).toBe(false);
		// 下一轮开始（turn_started）之后思考和增量照常处理。
		const next = run([started(4, 2), { type: "thinking" }, delta("新的一轮")], ended);
		expect(next.thinking).toBe(false);
		expect(next.items.at(-1)).toMatchObject({
			kind: "assistant",
			text: "新的一轮",
			streaming: true,
		});
		expect(run([started(4, 2), { type: "thinking" }], ended).thinking).toBe(true);
	});

	it("用户的话按 message_id 去重：同一句话不重复，连发两句相同的话是两句", () => {
		const first = user(1, "继续");
		const same = { ...user(2, "继续"), message_id: (first as { message_id: string }).message_id };
		expect(run([first, same]).items.filter((i) => i.kind === "user")).toHaveLength(1);
		const other = { ...user(2, "继续"), message_id: MSG(7) };
		expect(run([first, other]).items.filter((i) => i.kind === "user")).toHaveLength(2);
	});

	it("会话结束：状态是已结束；之后的 turn_end 不把它改回空闲", () => {
		const state = run([
			{ type: "session_ended", seq: 1, at: at(), by: "alice" },
			end(2, "completed"),
		]);
		expect(state.status).toBe("ended");
	});

	it("不认识的类型、没有对上调用的工具输出、什么现场都没有的快照不抛错，状态原样", () => {
		const base = run([user(1)]);
		const ignored: unknown[] = [
			{ type: "tool_output", call_id: "c", text: "partial" },
			{
				type: "snapshot",
				status: "running",
				partial_text: "",
				running_tool: null,
				steer_queue: [],
				waiting_for: null,
				queue_position: null,
			},
			{
				type: "platform",
				kind: "run",
				seq: 9,
				at: at(),
				turn: 1,
				run_id: MSG(1),
				scenario_name: "x",
			},
			{ type: "some_future_event", seq: 10, payload: 1 },
			{ type: "some_future_event" },
		];
		for (const event of ignored) {
			expect(() => applyEvent(base, event as SessionEvent)).not.toThrow();
		}
		expect(applyEvent(base, ignored[0] as SessionEvent)).toBe(base);
		expect(applyEvent(base, ignored[1] as SessionEvent)).toBe(base);
		expect(applyEvent(base, ignored[3] as SessionEvent).items).toEqual(base.items);
	});
});

describe("平台提交工作区的记录（platform 的 commit，#546）", () => {
	const commit = (
		seq: number,
		turn = 1,
		extra: Partial<Extract<SessionEvent, { type: "platform"; kind: "commit" }>> = {},
	): SessionEvent => ({
		type: "platform",
		kind: "commit",
		seq,
		at: at(),
		turn,
		hash: "3f1c2ab9d0e4a5b6c7d8e9f00112233445566778",
		files: [
			{ path: "nodes/http_check.py", additions: 12, deletions: 3 },
			{ path: "assets/logo.png", additions: null, deletions: null },
		],
		diff: "diff --git a/nodes/http_check.py b/nodes/http_check.py\n",
		truncated: false,
		...extra,
	});

	it("一行：提交号、文件、差异原样，排在这一轮的结局前面；不改变会话的状态", () => {
		const state = run([user(1), started(2), message(3, "改好了"), commit(4), end(5, "completed")]);
		expect(state.items.map((item) => item.kind)).toEqual([
			"user",
			"assistant",
			"commit",
			"turn_end",
		]);
		expect(state.items[2]).toEqual({
			kind: "commit",
			key: "e4",
			seq: 4,
			at: expect.any(String),
			turn: 1,
			leftover: false,
			beforeSession: false,
			hash: "3f1c2ab9d0e4a5b6c7d8e9f00112233445566778",
			files: [
				{ path: "nodes/http_check.py", additions: 12, deletions: 3 },
				{ path: "assets/logo.png", additions: null, deletions: null },
			],
			diff: "diff --git a/nodes/http_check.py b/nodes/http_check.py\n",
			truncated: false,
		});
		expect(state.status).toBe("idle");
		// 一轮在做时来的提交不改状态、不打断「在做」。
		const running = run([user(1), started(2), commit(3)]);
		expect(running.status).toBe("running");
		expect(running.turnOpen).toBe(true);
	});

	it("同一个序号来第二次（补发和事件流重叠）只有一行；差异太长的标截断", () => {
		const once = run([user(1), started(2), commit(3, 1, { truncated: true })]);
		expect(run([commit(3, 1, { truncated: true })], once).items).toEqual(once.items);
		expect(once.items.filter((item) => item.kind === "commit")).toHaveLength(1);
		expect(once.items[1]).toMatchObject({ kind: "commit", truncated: true });
	});

	it("补提交：上一轮被打断时留下的改动在这一轮开始前提交，事件的轮次比这一轮小；这一轮自己的提交不是", () => {
		const state = run([
			user(1),
			started(2, 1),
			end(3, "interrupted", { turn: 1 }),
			user(4, "接着做"),
			started(5, 2),
			commit(6, 1),
			commit(7, 2),
			end(8, "completed", { turn: 2 }),
		]);
		const commits = state.items.filter((item) => item.kind === "commit");
		expect(commits.map((item) => [item.turn, item.leftover])).toEqual([
			[1, true],
			[2, false],
		]);
	});

	it("会话开始之前工作区里留下的改动（第 1 轮开始前补提交）：事件的轮次就是这一轮，靠位置认——排在模型说话、调工具之前；这一轮自己的提交不是", () => {
		const state = run([
			user(1),
			started(2, 1),
			commit(3, 1),
			message(4, "做好了"),
			commit(5, 1),
			end(6, "completed", { turn: 1 }),
		]);
		const commits = state.items.filter((item) => item.kind === "commit");
		expect(commits.map((item) => [item.leftover, item.beforeSession])).toEqual([
			[true, true],
			[false, false],
		]);
		// 上一轮被打断留下的那种不是「会话开始之前」。
		const interrupted = run([
			user(1),
			started(2, 1),
			end(3, "interrupted", { turn: 1 }),
			user(4, "接着做"),
			started(5, 2),
			commit(6, 1),
		]);
		expect(interrupted.items.at(-1)).toMatchObject({ leftover: true, beforeSession: false });
	});

	it("这一页里没有 turn_started（它在更早的一页）：不判补提交；往前翻页读进来的提交也不改状态", () => {
		const page = initialTimeline("idle", [commit(10, 3), end(11, "completed", { turn: 3 })], true);
		expect(page.items[0]).toMatchObject({ kind: "commit", leftover: false });
		const older = prependHistory(page, [user(1), started(2, 3), commit(3, 3)], false);
		expect(older.items.map((item) => item.kind)).toEqual(["user", "commit", "commit", "turn_end"]);
		expect(older.status).toBe("idle");
		expect(older.lastSeq).toBe(11);
	});

	it("scenario_version、run 各添一行（#547），序号照常推进；一轮里它们后面的提交不是会话开始之前的补提交", () => {
		const base = run([user(1), started(2)]);
		const version = applyEvent(base, {
			type: "platform",
			kind: "scenario_version",
			seq: 3,
			at: at(),
			turn: 1,
			scenario_id: MSG(1),
			name: "接口巡检",
			version: 2,
		} as SessionEvent);
		expect(version.items.map((i) => i.kind)).toEqual([...base.items.map((i) => i.kind), "version"]);
		expect(version.lastSeq).toBe(3);
		// 模型调工具做了事（这里是触发运行）之后的提交，是这一轮自己的：补提交在把 `prompt` 交给模型之前。
		const after = applyEvent(version, {
			type: "platform",
			kind: "commit",
			seq: 4,
			at: at(),
			turn: 1,
			hash: "3f1c2ab9d0e4a5b6c7d8",
			files: [],
			diff: "",
			truncated: false,
		} as SessionEvent);
		const commit = after.items.at(-1);
		expect(commit).toMatchObject({ kind: "commit", beforeSession: false, leftover: false });
	});
});

describe("会话页打开：最近一页历史、接着事件流、往前翻页", () => {
	it("状态以会话视图为准，不由这一页历史推出来；序号和翻页的游标取自历史", () => {
		const state = initialTimeline("running", [user(5), started(6)], true);
		expect(state.status).toBe("running");
		expect(state.lastSeq).toBe(6);
		expect(state.oldestSeq).toBe(5);
		expect(state.hasMore).toBe(true);
		const idle = initialTimeline("idle", [user(1), started(2)], false);
		expect(idle.status).toBe("idle");
		expect(idle.thinking).toBe(false);
	});

	it("事件流从最大序号之后接上；重叠的事件不重复", () => {
		const opened = initialTimeline(
			"running",
			[user(1), started(2), call(3, "c", "command", "ls")],
			false,
		);
		const live = run([call(3, "c", "command", "ls"), result(4, "c"), end(5, "completed")], opened);
		expect(live.items.map((i) => i.kind)).toEqual(["user", "tool", "turn_end"]);
		expect(live.status).toBe("idle");
	});

	it("往前翻页：更早的放到前面；结果在后一页、调用在前一页的行合成一行", () => {
		const newest = initialTimeline(
			"idle",
			[result(3, "c", { text: "late" }), end(4, "completed")],
			true,
		);
		expect(newest.items[0]).toMatchObject({ kind: "tool", tool: null, result: { text: "late" } });
		const older = prependHistory(newest, [user(1), call(2, "c", "command", "make")], false);
		expect(older.hasMore).toBe(false);
		expect(older.oldestSeq).toBe(1);
		expect(older.items.map((i) => i.kind)).toEqual(["user", "tool", "turn_end"]);
		expect(older.items[1]).toMatchObject({
			tool: "command",
			title: "make",
			result: { text: "late" },
		});
		// 最大序号、状态不变。
		expect(older.lastSeq).toBe(4);
		expect(older.status).toBe("idle");
	});

	it("往前翻页：这一页里一直没有结果的调用不再算在做", () => {
		const newest = initialTimeline("idle", [user(3), end(4, "completed")], true);
		const older = prependHistory(newest, [call(1, "x", "command", "hang")], false);
		expect(older.items[0]).toMatchObject({ kind: "tool", callId: "x", abandoned: true });
	});
});

// ---------------------------------------------------------------------------
// #544 页面：插话、排队、结束会话
// ---------------------------------------------------------------------------

const ID_A = "a0000000-0000-4000-8000-00000000000a";
const ID_B = "b0000000-0000-4000-8000-00000000000b";
const ID_C = "c0000000-0000-4000-8000-00000000000c";
const WAITING_FOR = { session_id: MSG(9), title: "别的会话", created_by: "bob" };

const steerMsg = (seq: number, id: string, text: string): SessionEvent => ({
	type: "user_message",
	seq,
	at: at(),
	message_id: id,
	text,
	steer: true,
	author: "alice",
	author_user_id: null,
});
const plainMsg = (seq: number, id: string, text: string): SessionEvent => ({
	type: "user_message",
	seq,
	at: at(),
	message_id: id,
	text,
	steer: false,
	author: "alice",
	author_user_id: null,
});
const steerQueue = (...ids: string[]): SessionEvent => ({
	type: "steer_queue",
	messages: ids.map((message_id) => ({ message_id, text: "" })),
});
const dropped = (seq: number, id: string, message = "这句插话没有送到"): SessionEvent => ({
	type: "notice",
	seq,
	at: at(),
	kind: "steer_dropped",
	message,
	message_id: id,
});
const cancelled = (seq: number, id: string): SessionEvent => ({
	type: "notice",
	seq,
	at: at(),
	kind: "queue_cancelled",
	message: "这句话排队时被取消了，没有交给助手",
	message_id: id,
});
const queued = (position: number): SessionEvent => ({
	type: "turn_queued",
	position,
	waiting_for: WAITING_FOR,
});
const assistantMsg = (seq: number, text: string): SessionEvent => message(seq, text);
const userItems = (state: TimelineState) =>
	state.items.flatMap((item) => (item.kind === "user" ? [item] : []));
const byId = (state: TimelineState, id: string) =>
	userItems(state).find((item) => item.messageId === id);

describe("插话：在做时说的话", () => {
	it("在做时说的话（steer 为 true）是插话，一开始是等待送达；steer_queue 里还列着就仍是等待送达", () => {
		const state = run([user(1), started(2), steerMsg(3, ID_A, "先别改测试"), steerQueue(ID_A)]);
		expect(byId(state, ID_A)).toMatchObject({
			role: "steer",
			delivery: "waiting",
			queuedSeen: true,
		});
	});

	it("之前在 steer_queue 里、之后不在了：已送到；几句一起变成已送到", () => {
		let state = run([
			user(1),
			started(2),
			steerMsg(3, ID_A, "甲"),
			steerMsg(4, ID_B, "乙"),
			steerQueue(ID_A, ID_B),
		]);
		expect(byId(state, ID_A)?.delivery).toBe("waiting");
		state = applyEvent(state, steerQueue());
		expect(byId(state, ID_A)?.delivery).toBe("delivered");
		expect(byId(state, ID_B)?.delivery).toBe("delivered");
	});

	it("不因为一句话不在列表里就算送到：它没在任何一份队列里出现过（晚到的旧队列），仍是等待送达", () => {
		let state = run([user(1), started(2), steerMsg(3, ID_A, "甲")]);
		state = applyEvent(state, steerQueue());
		state = applyEvent(state, steerQueue(ID_B));
		expect(byId(state, ID_A)?.delivery).toBe("waiting");
	});

	it("steer_dropped 按 message_id 对上那句话：没有送到，写着通知给的那句说明；同一句话的两条通知只显示一次", () => {
		let state = run([
			user(1),
			started(2),
			steerMsg(3, ID_A, "甲"),
			steerQueue(ID_A),
			dropped(4, ID_A, "这句插话没有确认送到（……）：「甲」"),
		]);
		expect(byId(state, ID_A)).toMatchObject({
			delivery: "dropped",
			droppedNote: "这句插话没有确认送到（……）：「甲」",
		});
		state = applyEvent(state, dropped(5, ID_A, "这句插话没有送到：「甲」"));
		const notices = state.items.filter((item) => item.kind === "notice");
		expect(notices).toHaveLength(1);
		// 没送到的话之后不会因为队列里没有它又变成已送到。
		state = applyEvent(state, steerQueue());
		expect(byId(state, ID_A)?.delivery).toBe("dropped");
	});

	it("一轮结束时还没有 steer_dropped 的插话算送到（决定结束之后才送到的）", () => {
		const state = run([
			user(1),
			started(2),
			steerMsg(3, ID_A, "甲"),
			steerQueue(ID_A),
			steerMsg(4, ID_B, "乙"),
			dropped(5, ID_B),
			end(6, "stopped"),
		]);
		expect(byId(state, ID_A)?.delivery).toBe("delivered");
		expect(byId(state, ID_B)?.delivery).toBe("dropped");
	});

	it("刷新后读历史：这一轮已经结束的插话按有没有 steer_dropped 判断；在做的这一轮里的插话不知道，下一份 steer_queue 之后才知道", () => {
		const events = [
			user(1),
			started(2),
			steerMsg(3, ID_A, "甲"),
			dropped(4, ID_B),
			end(5, "stopped"),
			plainMsg(6, MSG(6), "接着做"),
			started(7, 2),
			steerMsg(8, ID_C, "丙"),
		];
		// ID_B 的 user_message 在更早的一页里：通知先到，这里只看 A、C。
		const state = initialTimeline("running", events, false);
		expect(byId(state, ID_A)?.delivery).toBe("delivered");
		expect(byId(state, ID_C)?.delivery).toBe("unknown");
		// 下一份 steer_queue 不含它：不能就此算送到（它可能还没到助手服务手上），仍是不知道；在一份列表里见到它才是等待送达。
		const next = applyEvent(state, steerQueue());
		expect(byId(next, ID_C)?.delivery).toBe("unknown");
		const listed = applyEvent(state, steerQueue(ID_C));
		expect(byId(listed, ID_C)).toMatchObject({ delivery: "waiting", queuedSeen: true });
		// 见到了之后又不在了：送到了。
		expect(byId(applyEvent(listed, steerQueue()), ID_C)?.delivery).toBe("delivered");
	});

	it("刷新后不知道的插话：一份不含它的列表不算送到，之后含它的列表也不被改回；这一轮结束时没有 steer_dropped 才算送到，有就是没有送到", () => {
		// 审查 A1：刷新时这句话（乙）还没到助手服务手上；另一句（甲）送到了，列表变化发了一份不含乙的。
		const loaded = initialTimeline(
			"running",
			[user(1), started(2), steerMsg(3, ID_A, "甲"), steerMsg(4, ID_B, "乙")],
			false,
		);
		expect([byId(loaded, ID_A)?.delivery, byId(loaded, ID_B)?.delivery]).toEqual([
			"unknown",
			"unknown",
		]);
		const emptied = applyEvent(loaded, steerQueue());
		expect([byId(emptied, ID_A)?.delivery, byId(emptied, ID_B)?.delivery]).toEqual([
			"unknown",
			"unknown",
		]);
		// 助手服务收下乙：列表里有它——等待送达，不是已送到。
		const listed = applyEvent(emptied, steerQueue(ID_B));
		expect(byId(listed, ID_B)).toMatchObject({ delivery: "waiting", queuedSeen: true });
		expect(byId(listed, ID_A)?.delivery).toBe("unknown");
		// 这一轮结束：没有 steer_dropped 的都算送到。
		const finished = applyEvent(listed, end(5, "completed"));
		expect([byId(finished, ID_A)?.delivery, byId(finished, ID_B)?.delivery]).toEqual([
			"delivered",
			"delivered",
		]);
		// 有 steer_dropped 的是没有送到。
		const lost = applyEvent(applyEvent(emptied, dropped(5, ID_B)), end(6, "completed"));
		expect([byId(lost, ID_A)?.delivery, byId(lost, ID_B)?.delivery]).toEqual([
			"delivered",
			"dropped",
		]);
	});

	it("往前翻页不动在做的这一轮里已经有的插话：等待送达仍是等待送达，不知道仍是不知道；之后一份不含它的列表也不算送到", () => {
		// 审查 A2：在做的一轮里甲等待送达（在列表里见过一次，页面一直开着）。
		let state = initialTimeline("running", [user(51), started(52)], true);
		state = run([steerMsg(53, ID_A, "甲"), steerQueue(ID_A)], state);
		expect(byId(state, ID_A)).toMatchObject({ delivery: "waiting", queuedSeen: true });
		const older = [user(1, "很早的话"), started(2), end(3, "completed")];
		const turned = prependHistory(state, older, false);
		expect(byId(turned, ID_A)).toMatchObject({ delivery: "waiting", queuedSeen: true });
		// 之后甲真的送到了（见过又不在了）：已送到。
		expect(byId(applyEvent(turned, steerQueue()), ID_A)?.delivery).toBe("delivered");
		// 往前翻页读进来的更早的一轮里的插话照读历史判断：这一轮已经结束了，送到了。
		const withSteer = prependHistory(
			state,
			[user(1, "很早的话"), started(2), steerMsg(3, ID_B, "乙"), end(4, "completed")],
			false,
		);
		expect(byId(withSteer, ID_B)?.delivery).toBe("delivered");
		expect(byId(withSteer, ID_A)).toMatchObject({ delivery: "waiting", queuedSeen: true });

		// 刷新后不知道的，翻页之后仍是不知道，不会因为一份不含它的列表就算送到。
		let reloaded = initialTimeline("running", [steerMsg(53, ID_A, "甲")], true);
		reloaded = prependHistory(reloaded, older, false);
		expect(byId(reloaded, ID_A)?.delivery).toBe("unknown");
		expect(byId(applyEvent(reloaded, steerQueue()), ID_A)?.delivery).toBe("unknown");
	});

	it("补发的次序：steer_queue 比它之后才落库的 turn_end 先到、却排在后面放出——这一轮已经结束，晚到的队列不改任何一句的状态", () => {
		let state = run([user(1), started(2), steerMsg(3, ID_A, "甲"), end(4, "completed")]);
		expect(byId(state, ID_A)?.delivery).toBe("delivered");
		state = applyEvent(state, steerQueue(ID_A));
		expect(state.steerQueue).toEqual([]);
		expect(byId(state, ID_A)?.delivery).toBe("delivered");
	});

	it("补发的次序：steer_queue 在这句话的 user_message 之前就到了（补发放出的先后）：这句话一出现就已经在队列里", () => {
		let state = run([user(1), started(2)]);
		state = applyEvent(state, steerQueue(ID_A));
		state = applyEvent(state, steerMsg(3, ID_A, "甲"));
		expect(byId(state, ID_A)).toMatchObject({ delivery: "waiting", queuedSeen: true });
		state = applyEvent(state, steerQueue());
		expect(byId(state, ID_A)?.delivery).toBe("delivered");
	});
});

describe("停止途中说的话、排队中的会话", () => {
	it("停止途中说的话（steer 为 false、一轮还在进行）：排在这一轮后面，不是插话；这一轮的结局写下之后会话是排队中；它开始时是开一轮的话", () => {
		let state = run([user(1), started(2), plainMsg(3, ID_A, "停下来之后的话")]);
		expect(byId(state, ID_A)).toMatchObject({ role: "behind", delivery: null });
		expect(state.status).toBe("running");
		state = applyEvent(state, queued(1));
		expect(state.queue).toEqual({ position: 1, waitingFor: WAITING_FOR });
		state = applyEvent(state, end(4, "stopped"));
		expect(state.status).toBe("queued");
		expect(state.queue).not.toBeNull();
		state = applyEvent(state, started(5, 2));
		expect(state.status).toBe("running");
		expect(state.queue).toBeNull();
		expect(byId(state, ID_A)?.role).toBe("turn");
	});

	it("再点一次停止：排着的话被撤掉（queue_cancelled），那一行标成撤掉了；这一轮结束之后会话回到空闲，不是排队中", () => {
		let state = run([user(1), started(2), plainMsg(3, ID_A, "说错了的话"), queued(1)]);
		state = applyEvent(state, cancelled(4, ID_A));
		expect(byId(state, ID_A)?.role).toBe("cancelled");
		expect(state.queue).toBeNull();
		state = applyEvent(state, end(5, "stopped"));
		expect(state.status).toBe("idle");
	});

	it("空闲的会话说话、项目里别的会话在做：user_message 之后 turn_queued 让会话变成排队中，位置前进时跟着变；开始之后不再是排队中", () => {
		let state = run([user(1), started(2), end(3, "completed")], emptyTimeline("idle"));
		state = applyEvent(state, plainMsg(4, ID_A, "接着做"));
		expect(state.status).toBe("idle");
		state = applyEvent(state, queued(2));
		expect(state.status).toBe("queued");
		expect(state.queue?.position).toBe(2);
		state = applyEvent(state, queued(1));
		expect(state.queue?.position).toBe(1);
		state = applyEvent(state, started(5, 2));
		expect(state.status).toBe("running");
		expect(state.queue).toBeNull();
	});

	it("排队中点停止（queue_cancelled）：回到空闲，没有排位", () => {
		let state = run([plainMsg(1, ID_A, "甲"), queued(1)], emptyTimeline("idle"));
		expect(state.status).toBe("queued");
		state = applyEvent(state, cancelled(2, ID_A));
		expect(state.status).toBe("idle");
		expect(state.queue).toBeNull();
		expect(byId(state, ID_A)?.role).toBe("cancelled");
	});

	it("补发的次序：turn_queued 排在已经开始过的那一轮的 turn_started、turn_end 后面放出：会话不变成排队中", () => {
		let state = run([user(1), started(2), end(3, "completed")], emptyTimeline("idle"));
		state = applyEvent(state, queued(1));
		expect(state.status).toBe("idle");
		expect(state.queue).toBeNull();
		// 说了话、还在等开始的会话也一样：开始之后晚到的旧位置不让它回到排队中。
		state = run([plainMsg(4, ID_A, "接着做"), started(5, 2)], state);
		state = applyEvent(state, queued(1));
		expect(state.status).toBe("running");
		expect(state.queue).toBeNull();
	});

	it("会话视图说在排队：状态和排位取自视图，不由这一页历史推出来；之后 turn_queued 照常更新", () => {
		const events = [user(1), started(2), end(3, "completed"), plainMsg(4, ID_A, "接着做")];
		let state = initialTimeline("queued", events, false, { position: 3, waitingFor: WAITING_FOR });
		expect(state.status).toBe("queued");
		expect(state.queue?.position).toBe(3);
		state = applyEvent(state, queued(2));
		expect(state.queue?.position).toBe(2);
	});

	it("会话视图说在做、而且有排位（停止途中说了话）：那句话读成排在后面的话", () => {
		const events = [user(1), started(2), plainMsg(3, ID_A, "停下来之后的话")];
		const state = initialTimeline("running", events, false, {
			position: 1,
			waitingFor: WAITING_FOR,
		});
		expect(byId(state, ID_A)?.role).toBe("behind");
		expect(state.queue?.position).toBe(1);
	});

	it("在做、视图里有排位，而这一页里没有这一轮的 turn_started（在更早的一页）：按视图的排位认出排在后面的话", () => {
		const events = [assistantMsg(5, "做着"), plainMsg(6, ID_A, "停下来之后的话")];
		const state = initialTimeline("running", events, true, {
			position: 1,
			waitingFor: WAITING_FOR,
		});
		expect(byId(state, ID_A)?.role).toBe("behind");
		expect(state.awaitingStart).toBe(true);
	});

	it("在做、视图里没有排位，这一页里没有 turn_started：不当成排在后面的话（开一轮的话）", () => {
		const state = initialTimeline("running", [plainMsg(1, ID_A, "第一句")], false);
		expect(byId(state, ID_A)?.role).toBe("turn");
	});

	it("这一页历史从一轮中间开始（turn_started 在更早的一页）：先出现的是 turn_end，开头的话是排在后面的话还是插话按 steer 判断", () => {
		const events = [plainMsg(10, ID_A, "停下来之后的话"), end(11, "stopped")];
		const state = initialTimeline("queued", events, true, { position: 1, waitingFor: null });
		expect(byId(state, ID_A)?.role).toBe("behind");
	});
});

describe("结束会话", () => {
	it("session_ended 一行：写是谁结束的；状态是已结束，之后的 turn_queued、steer_queue 都不算", () => {
		let state = run([user(1), started(2), end(3, "stopped")]);
		state = applyEvent(state, { type: "session_ended", seq: 4, at: at(), by: "bob" });
		expect(state.status).toBe("ended");
		expect(state.items.at(-1)).toEqual({
			kind: "session_ended",
			key: "e4",
			seq: 4,
			at: expect.any(String),
			by: "bob",
		});
		expect(applyEvent(state, queued(1))).toBe(state);
		expect(applyEvent(state, steerQueue(ID_A))).toBe(state);
	});

	it("停止途中说了话又结束会话：那句话被撤掉（queue_cancelled），再写 session_ended；状态是已结束", () => {
		let state = run([user(1), started(2), plainMsg(3, ID_A, "停下来之后的话"), queued(1)]);
		state = applyEvent(state, cancelled(4, ID_A));
		state = applyEvent(state, end(5, "stopped"));
		state = applyEvent(state, { type: "session_ended", seq: 6, at: at(), by: "alice" });
		expect(state.status).toBe("ended");
		expect(byId(state, ID_A)?.role).toBe("cancelled");
	});
});

describe("说话之后核对一次状态：排上了队、控制面没有推 turn_queued", () => {
	const idleAfterTurn = () =>
		run([user(1), started(2), end(3, "completed")], emptyTimeline("idle"));
	const queue = { position: 1, waitingFor: null };

	it("空闲的会话说了话（user_message 到了、状态仍是空闲）：视图说在排队，就是排队中，输入框不可用；之后开始就是在做", () => {
		let state = run([plainMsg(4, ID_A, "接着做")], idleAfterTurn());
		expect(state.status).toBe("idle");
		state = applyQueuedView(state, queue, 3);
		expect(state).toMatchObject({ status: "queued", queue: { position: 1, waitingFor: null } });
		state = applyEvent(state, started(5, 2));
		expect(state.status).toBe("running");
	});

	it("视图比这句话的 user_message 先到也一样；已经在做、已经结束的（开始的事件比视图先到）不改", () => {
		const before = applyQueuedView(idleAfterTurn(), { position: 2, waitingFor: WAITING_FOR }, 3);
		expect(before.status).toBe("queued");
		const after = applyEvent(before, plainMsg(4, ID_A, "接着做"));
		expect(after.status).toBe("queued");
		const running = run([plainMsg(4, ID_A, "接着做"), started(5, 2)], idleAfterTurn());
		expect(applyQueuedView(running, queue, 3)).toBe(running);
		const finished = applyEvent(emptyTimeline("running"), {
			type: "session_ended",
			seq: 9,
			at: at(),
			by: "bob",
		});
		expect(applyQueuedView(finished, queue, 3)).toBe(finished);
	});

	it("审查的 B2：视图在事件之前取、回应在事件之后到——这句话已经开始又结束了，或者被移出了队列：以事件为准，不把会话改回排队中", () => {
		// (a) 回应到之前，这句话的一轮已经开始又结束了（马上失败）。
		const started_ = run(
			[plainMsg(4, ID_A, "第二句"), started(5, 2), end(6, "failed", { turn: 2 })],
			idleAfterTurn(),
		);
		expect(started_.status).toBe("idle");
		expect(applyQueuedView(started_, queue, 3)).toBe(started_);
		// (b) 回应到之前，别人把它移出了队列（queue_cancelled）。
		const cancelledBefore = run([plainMsg(4, ID_A, "第二句"), cancelled(5, ID_A)], idleAfterTurn());
		expect(cancelledBefore.status).toBe("idle");
		expect(applyQueuedView(cancelledBefore, queue, 3)).toBe(cancelledBefore);
		// 这句话自己的 user_message 比视图先到是常态（序号大于 after，不算「之后已经结束」）：照常是排队中。
		const onlyMessage = run([plainMsg(4, ID_A, "第二句")], idleAfterTurn());
		expect(applyQueuedView(onlyMessage, queue, 3).status).toBe("queued");
		// 更早的结局（序号不大于发出这句话时的最大序号）不算。
		expect(applyQueuedView(idleAfterTurn(), queue, 3).status).toBe("queued");
	});
});

// ---------------------------------------------------------------------------
// #545 页面：正在跑的命令的输出、快照
// ---------------------------------------------------------------------------

const OUTPUT_LIMIT = SESSION_EVENT_LIMITS.runningToolOutputBytes;
/** 一轮刚结束、空闲的会话（别的标签页说的话排上队之前的样子）。 */
const idleAfterTurnState = () =>
	run([user(1), started(2), end(3, "completed")], emptyTimeline("idle"));
const utf8 = (text: string) => new TextEncoder().encode(text).length;
const toolOutput = (callId: string, text: string): SessionEvent => ({
	type: "tool_output",
	call_id: callId,
	text,
});
type Snapshot = Extract<SessionEvent, { type: "snapshot" }>;
const snapshot = (over: Partial<Snapshot> = {}): SessionEvent => ({
	type: "snapshot",
	status: "running",
	partial_text: "",
	running_tool: null,
	steer_queue: [],
	waiting_for: null,
	queue_position: null,
	...over,
});
const toolRow = (state: TimelineState, callId: string) =>
	state.items.find(
		(item): item is Extract<TimelineState["items"][number], { kind: "tool" }> =>
			item.kind === "tool" && item.callId === callId,
	);
const assistants = (state: TimelineState) =>
	state.items.flatMap((item) => (item.kind === "assistant" ? [item] : []));

describe("正在跑的命令输出的最后一段（tool_output，#545）", () => {
	it("追加到同一个调用那一行的 output（#550 用的字段）；一开始是空字符串", () => {
		let state = run([user(1), started(2), call(3, "c1", "command", "sleep 600")]);
		expect(toolRow(state, "c1")?.output).toBe("");
		state = applyEvent(state, toolOutput("c1", "第一行\n"));
		state = applyEvent(state, toolOutput("c1", "第二行\n"));
		expect(toolRow(state, "c1")?.output).toBe("第一行\n第二行\n");
	});

	it("几个调用各记各的；没有对上的调用（调用在更早的一页里）的输出不认", () => {
		let state = run([
			user(1),
			started(2),
			call(3, "c1", "command", "a"),
			call(4, "c2", "command", "b"),
		]);
		state = applyEvent(state, toolOutput("c1", "甲"));
		state = applyEvent(state, toolOutput("c2", "乙"));
		expect(toolRow(state, "c1")?.output).toBe("甲");
		expect(toolRow(state, "c2")?.output).toBe("乙");
		expect(applyEvent(state, toolOutput("没见过", "丙"))).toBe(state);
	});

	it("结果到了清空：改看 result.text；结果之后迟到的输出不再追加", () => {
		let state = run([
			user(1),
			started(2),
			call(3, "c1", "command", "ls"),
			toolOutput("c1", "半截"),
		]);
		state = applyEvent(state, result(4, "c1", { text: "完整的输出\n" }));
		expect(toolRow(state, "c1")).toMatchObject({ output: "", result: { text: "完整的输出\n" } });
		expect(applyEvent(state, toolOutput("c1", "迟到的"))).toBe(state);
	});

	it("一轮结束、这个调用被中止之后到的输出不再追加", () => {
		let state = run([user(1), started(2), call(3, "c1", "command", "sleep 600")]);
		state = applyEvent(state, end(4, "stopped"));
		expect(toolRow(state, "c1")?.abandoned).toBe(true);
		expect(applyEvent(state, toolOutput("c1", "迟到的"))).toBe(state);
	});

	it("只留最后 runningToolOutputBytes 个 UTF-8 字节，不切开字符", () => {
		let state = run([user(1), started(2), call(3, "c1", "command", "yes")]);
		const lines = Array.from({ length: 3000 }, (_, i) => `行 ${String(i).padStart(5, "0")}\n`);
		for (const line of lines) state = applyEvent(state, toolOutput("c1", line));
		const output = toolRow(state, "c1")?.output ?? "";
		expect(utf8(output)).toBeLessThanOrEqual(OUTPUT_LIMIT);
		expect(utf8(output)).toBeGreaterThan(OUTPUT_LIMIT - 8);
		expect(lines.join("").endsWith(output)).toBe(true);
		expect(output).not.toContain("�");
		// 一次进来很大一段，截断点落在多字节字符中间。
		const big = applyEvent(
			run([user(1), started(2), call(3, "c2", "command", "x")]),
			toolOutput("c2", "你".repeat(OUTPUT_LIMIT)),
		);
		const bigOutput = toolRow(big, "c2")?.output ?? "";
		expect(utf8(bigOutput)).toBeLessThanOrEqual(OUTPUT_LIMIT);
		expect(bigOutput).not.toContain("�");
		expect([...bigOutput].every((char) => char === "你")).toBe(true);
	});

	it("lastBytes：不超过上限原样，超过留最后的字节，每个截断位置都不产生半个字符", () => {
		expect(lastBytes("abc", 10)).toBe("abc");
		expect(lastBytes("abcdef", 3)).toBe("def");
		const text = "a你😀b你😀c".repeat(4);
		for (let limit = 0; limit <= utf8(text) + 2; limit++) {
			const cut = lastBytes(text, limit);
			expect(utf8(cut)).toBeLessThanOrEqual(limit);
			expect(cut, `limit ${limit}`).not.toContain("�");
			expect(text.endsWith(cut)).toBe(true);
		}
	});
});

describe("快照（snapshot，#545）：控制面补发读完、切到实时的那一刻发的现场，取代、不追加", () => {
	it("正在输出的文字：取代逐字出现的那一条；没有逐字出现的（刚打开的页面）就新起一条；之后的增量接着追加，整条消息以它为准", () => {
		// 断线重连：页面只收到了「我先」。
		let state = run([user(1), started(2), delta("我先")]);
		state = applyEvent(state, snapshot({ partial_text: "我先看一下现有的" }));
		expect(assistants(state)).toHaveLength(1);
		expect(assistants(state)[0]).toMatchObject({ text: "我先看一下现有的", streaming: true });
		// 之后的实时增量接在快照的文字后面。
		state = applyEvent(state, delta("节点"));
		expect(assistants(state)[0]?.text).toBe("我先看一下现有的节点");
		state = applyEvent(state, message(3, "我先看一下现有的节点。"));
		expect(assistants(state)).toEqual([
			expect.objectContaining({ seq: 3, text: "我先看一下现有的节点。", streaming: false }),
		]);
		// 刚打开的页面：读到的历史里没有逐字出现的那条。
		const fresh = initialTimeline("running", [user(1), started(2)], false);
		const opened = applyEvent(fresh, snapshot({ partial_text: "已经输出的部分" }));
		expect(assistants(opened)).toEqual([
			expect.objectContaining({ text: "已经输出的部分", streaming: true, seq: null }),
		]);
	});

	it("相对「上一条持久的助手消息」：补发里的整条消息在前，快照里的文字是它之后的那条，不被它盖掉", () => {
		// 补发（读历史）带来了第 3 条整条消息；快照的文字是下一条消息已有的部分。
		const state = applyEvent(
			initialTimeline("running", [user(1), started(2), message(3, "第一条")], false),
			snapshot({ partial_text: "第二条已经输出的" }),
		);
		expect(assistants(state).map((item) => [item.seq, item.text, item.streaming])).toEqual([
			[3, "第一条", false],
			[null, "第二条已经输出的", true],
		]);
	});

	it("同一个快照收到几次、和已经收到的增量重叠：结果一样", () => {
		const snap = snapshot({ partial_text: "我先看一下" });
		const once = applyEvent(run([user(1), started(2), delta("我先看")]), snap);
		const twice = applyEvent(once, snap);
		expect(assistants(twice)).toEqual(assistants(once));
		expect(assistants(twice)).toHaveLength(1);
	});

	it("页面已有的文字以快照的文字结尾（控制面重启过，快照里只有重启之后的一段）：不动", () => {
		const state = run([user(1), started(2), delta("重启之前的，"), delta("重启之后的")]);
		const next = applyEvent(state, snapshot({ partial_text: "重启之后的" }));
		expect(assistants(next)[0]?.text).toBe("重启之前的，重启之后的");
	});

	it("文字是空的（没有正在输出的消息，或者控制面刚重启）：页面上逐字出现的那条不动", () => {
		const state = run([user(1), started(2), delta("已有的")]);
		expect(applyEvent(state, snapshot({ partial_text: "" }))).toBe(state);
	});

	it("正在跑的工具：output 写进同一个调用那一行（和实时的 tool_output 同一个字段）；页面没有这一行就补一行", () => {
		const running = {
			call_id: "c1",
			tool: "command" as const,
			title: "sfly run start 巡检",
			output: "已经输出的最后一段\n",
		};
		// 重连：页面有这一行，没收到期间的输出。
		let state = run([
			user(1),
			started(2),
			call(3, "c1", "command", "sfly run start 巡检"),
			toolOutput("c1", "第一行\n"),
		]);
		state = applyEvent(state, snapshot({ running_tool: running }));
		expect(toolRow(state, "c1")).toMatchObject({
			output: "已经输出的最后一段\n",
			result: null,
			abandoned: false,
		});
		// 之后的实时输出接着追加。
		state = applyEvent(state, toolOutput("c1", "又一行\n"));
		expect(toolRow(state, "c1")?.output).toBe("已经输出的最后一段\n又一行\n");
		// 页面没有这一行（调用在更早的一页里）：补一行。
		const missing = applyEvent(run([user(1), started(2)]), snapshot({ running_tool: running }));
		expect(toolRow(missing, "c1")).toMatchObject({
			kind: "tool",
			tool: "command",
			title: "sfly run start 巡检",
			output: "已经输出的最后一段\n",
			result: null,
			abandoned: false,
		});
		// 同一个快照再来一次不重复。
		const again = applyEvent(missing, snapshot({ running_tool: running }));
		expect(again.items.filter((item) => item.kind === "tool")).toHaveLength(1);
	});

	it("已经有结果或被中止的调用不动；页面已有的输出以快照的结尾时不动；没有在跑的工具（null）什么也不做", () => {
		const running = { call_id: "c1", tool: "command" as const, title: "ls", output: "尾" };
		const finished = run([
			user(1),
			started(2),
			call(3, "c1", "command", "ls"),
			result(4, "c1", { text: "完整\n" }),
		]);
		expect(toolRow(applyEvent(finished, snapshot({ running_tool: running })), "c1")).toMatchObject({
			output: "",
			result: { text: "完整\n" },
		});
		const longer = run([
			user(1),
			started(2),
			call(3, "c1", "command", "ls"),
			toolOutput("c1", "前面的尾"),
		]);
		expect(applyEvent(longer, snapshot({ running_tool: running }))).toBe(longer);
		expect(applyEvent(longer, snapshot({ running_tool: null }))).toBe(longer);
	});

	it("快照里的输出是控制面按字节截好的，页面不再改：不超过上限", () => {
		const output = "x".repeat(OUTPUT_LIMIT);
		const state = applyEvent(
			run([user(1), started(2), call(3, "c1", "command", "yes")]),
			snapshot({ running_tool: { call_id: "c1", tool: "command", title: "yes", output } }),
		);
		expect(utf8(toolRow(state, "c1")?.output ?? "")).toBeLessThanOrEqual(OUTPUT_LIMIT);
	});

	it("还没送到模型的插话：在列表里的变成等待送达；不在列表里的不因此算送到（控制面重启后快照里的队列是空的）", () => {
		// 刷新后读到的在做的一轮里的插话是「不知道」。
		const opened = initialTimeline(
			"running",
			[user(1), started(2), steerMsg(3, ID_A, "甲"), steerMsg(4, ID_B, "乙")],
			false,
		);
		expect(byId(opened, ID_A)?.delivery).toBe("unknown");
		const listed = applyEvent(
			opened,
			snapshot({ steer_queue: [{ message_id: ID_A, text: "甲" }] }),
		);
		expect(byId(listed, ID_A)).toMatchObject({ delivery: "waiting", queuedSeen: true });
		expect(byId(listed, ID_B)?.delivery).toBe("unknown");
		// 之前在队列里见过：快照里的队列是空的（控制面重启过），仍是等待送达，不算送到。
		const afterRestart = applyEvent(listed, snapshot({ steer_queue: [] }));
		expect(byId(afterRestart, ID_A)?.delivery).toBe("waiting");
		// 之后实时的 steer_queue 里没有它了，才是已送到。
		expect(byId(applyEvent(afterRestart, steerQueue()), ID_A)?.delivery).toBe("delivered");
		// 没有送到的（有 steer_dropped）不被快照改成等待送达。
		const gone = applyEvent(
			run([user(1), started(2), steerMsg(3, ID_A, "甲"), dropped(4, ID_A)]),
			snapshot({ steer_queue: [{ message_id: ID_A, text: "甲" }] }),
		);
		expect(byId(gone, ID_A)?.delivery).toBe("dropped");
	});

	it("快照比这句插话的 user_message 先到：之后到的 user_message 一来就是等待送达", () => {
		let state = initialTimeline("running", [user(1), started(2)], false);
		state = applyEvent(state, snapshot({ steer_queue: [{ message_id: ID_A, text: "甲" }] }));
		state = applyEvent(state, steerMsg(3, ID_A, "甲"));
		expect(byId(state, ID_A)).toMatchObject({ delivery: "waiting", queuedSeen: true });
	});

	it("排队中：快照里的位置和在等谁取代页面上的（重连后排位马上对）；空闲的页面也变成排队中（别的标签页说的话排上了队）", () => {
		const queuedState = initialTimeline("queued", [plainMsg(1, ID_A, "排着的话")], false, {
			position: 3,
			waitingFor: WAITING_FOR,
		});
		const moved = applyEvent(
			queuedState,
			snapshot({ status: "queued", queue_position: 1, waiting_for: WAITING_FOR }),
		);
		expect(moved.status).toBe("queued");
		expect(moved.queue).toEqual({ position: 1, waitingFor: WAITING_FOR });
		// 项目里没有会话在做：在等谁是 null，位置仍有。
		const nobody = applyEvent(
			queuedState,
			snapshot({ status: "queued", queue_position: 2, waiting_for: null }),
		);
		expect(nobody.queue).toEqual({ position: 2, waitingFor: null });
		// 页面是空闲的（别的标签页说的话排上了队，这一页读到了它的 user_message）。
		const idle = run([plainMsg(4, ID_A, "第二句")], idleAfterTurnState());
		const waiting = applyEvent(
			idle,
			snapshot({ status: "queued", queue_position: 1, waiting_for: null }),
		);
		expect(waiting).toMatchObject({
			status: "queued",
			awaitingStart: true,
			queue: { position: 1, waitingFor: null },
		});
	});

	it("停止途中说了话、排在这一轮后面的在做的会话：位置前进了，页面状态仍是在做", () => {
		const state = run([user(1), started(2), plainMsg(3, ID_A, "停下来之后的话")]);
		expect(hasBehind(state.items)).toBe(true);
		const next = applyEvent(
			state,
			snapshot({ status: "running", queue_position: 2, waiting_for: WAITING_FOR }),
		);
		expect(next.status).toBe("running");
		expect(next.queue).toEqual({ position: 2, waitingFor: WAITING_FOR });
	});

	it("快照说没有在做（空闲、已结束），或者页面不在做：不画文字、命令和插话", () => {
		const idleSnap = snapshot({
			status: "idle",
			partial_text: "过时的",
			running_tool: { call_id: "c1", tool: "command", title: "ls", output: "x" },
			steer_queue: [{ message_id: ID_A, text: "甲" }],
		});
		const running = run([user(1), started(2)]);
		expect(applyEvent(running, idleSnap)).toBe(running);
		const idle = run([user(1), started(2), end(3, "completed")]);
		const withContent = snapshot({ partial_text: "不该画的", running_tool: null });
		expect(applyEvent(idle, withContent)).toBe(idle);
	});

	it("turn_queued 的 waiting_for 为 null（项目里没有会话在做）：空闲的会话说的话排上了队，位置有、在等谁没有", () => {
		let state = run([plainMsg(4, ID_A, "第二句")], idleAfterTurnState());
		state = applyEvent(state, { type: "turn_queued", position: 2, waiting_for: null });
		expect(state).toMatchObject({ status: "queued", queue: { position: 2, waitingFor: null } });
	});
});
