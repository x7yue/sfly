import type { SessionEvent } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	applyEvent,
	emptyTimeline,
	initialTimeline,
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

	it("这一版不渲染的类型和不认识的类型不抛错，状态原样", () => {
		const base = run([user(1)]);
		const ignored: unknown[] = [
			{
				type: "turn_queued",
				position: 1,
				waiting_for: { session_id: MSG(1), title: "t", created_by: "bob" },
			},
			{ type: "tool_output", call_id: "c", text: "partial" },
			{ type: "steer_queue", messages: [] },
			{
				type: "snapshot",
				status: "running",
				partial_text: "",
				running_tool: null,
				steer_queue: [],
				waiting_for: null,
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
		expect(applyEvent(base, ignored[5] as SessionEvent).items).toEqual(base.items);
	});
});

describe("会话页打开：最近一页历史、接着事件流、往前翻页", () => {
	it("序号和翻页的游标取自历史", () => {
		const state = initialTimeline("running", [user(5), started(6)], true);
		expect(state.lastSeq).toBe(6);
		expect(state.oldestSeq).toBe(5);
		expect(state.hasMore).toBe(true);
		expect(state.thinking).toBe(false);
	});

	it("状态由这一页里最后一条状态性的事件推出来（turn_started 在做、turn_end 空闲、session_ended 结束），视图里的状态不算", () => {
		// 读到视图里的「在做」之后这一轮结束了：响应带着状态「在做」和已经带着 turn_end 的事件。事件流从这一页最大的序号之后接，
		// 这条结局不会再来，页面不能停在「在做」。
		const raced = initialTimeline("running", [user(1), started(2), end(3, "completed")], false);
		expect(raced.status).toBe("idle");
		// 反过来：视图说空闲，事件里最后是 turn_started。
		expect(initialTimeline("idle", [user(1), started(2)], false).status).toBe("running");
		// 一页里有几轮：看最后一条。
		expect(
			initialTimeline(
				"idle",
				[started(1, 1), end(2, "completed", { turn: 1 }), started(3, 2)],
				false,
			).status,
		).toBe("running");
		expect(
			initialTimeline("running", [{ type: "session_ended", seq: 4, at: at(), by: "alice" }], false)
				.status,
		).toBe("ended");
	});

	it("这一页里没有状态性的事件时用会话视图里的状态：没有事件、或一页全是工具行", () => {
		expect(initialTimeline("idle", [], false).status).toBe("idle");
		expect(initialTimeline("running", [], false).status).toBe("running");
		expect(initialTimeline("ended", [], false).status).toBe("ended");
		const tools = [call(7, "c", "command", "make"), result(8, "c")];
		expect(initialTimeline("running", tools, true).status).toBe("running");
		expect(initialTimeline("idle", tools, true).status).toBe("idle");
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
