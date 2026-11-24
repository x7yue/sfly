// 「可以打断助手」（#544）：协议（@sfly/schema 的 assistant-protocol.ts 文件头）里「一轮的状态」那张表的每一格、停止一轮的步骤和时间、
// 插话的不变式、结束会话。用真的助手服务（HTTP、事件流）和照 RPC 协议说话的假 pi（support/fake-pi.mjs）；pi 自己的行为
// （abort 之后进程留着、clear_queue、一次全送、按顺序认送到……）是 rpcprobe 第 11 到 17 题在真的 pi 上测过的（evals/assistant）。
// 停止的时间用手动推进的时钟测（support/manual-clock.ts），不真的等十几秒。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	ASSISTANT_ABORT_SETTLE_MS,
	ASSISTANT_PROCESS_KILL_GRACE_MS,
	ASSISTANT_STOP_WAIT_MS,
	type AssistantEvent,
} from "@sfly/schema";
import { afterEach, describe, expect, it } from "vitest";
import { eventually } from "./support/eventually.js";
import { Harness, type HarnessOptions, SECRET } from "./support/harness.js";
import { ManualClock } from "./support/manual-clock.js";

const FAKE_PI = [process.execPath, join(import.meta.dirname, "support", "fake-pi.mjs")];

let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

const start = async (options: HarnessOptions = {}) => {
	h = await Harness.start({ piArgv: FAKE_PI, ...options });
	return h;
};

/** 这个会话的 pi 原始事件（`events.jsonl`）。 */
const rawEvents = (harness: Harness, id: string): Array<Record<string, unknown>> => {
	const path = join(harness.dataDir, "sessions", id, "events.jsonl");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
};
const rawTypes = (harness: Harness, id: string) => rawEvents(harness, id).map((r) => r.type);

/** 这个会话第 `turn` 轮发出的事件，按先后。 */
const eventsOf = (harness: Harness, id: string, turn?: number): AssistantEvent[] =>
	harness.events
		.of(id)
		.filter((r) => turn === undefined || r.turn === turn)
		.map((r) => r.event);

/** 等 pi 拿到这一轮的 `prompt`（假 pi 报了 turn_start）。 */
const started = (harness: Harness, id: string, count = 1) =>
	eventually(() =>
		expect(
			rawEvents(harness, id).filter((r) => r.type === "turn_start").length,
		).toBeGreaterThanOrEqual(count),
	);

const kinds = (events: AssistantEvent[]) =>
	events.map((e) => (e.type === "notice" ? `notice:${e.kind}` : e.type));

describe("命令的请求体", () => {
	it("steer 的请求体要有 turn、message_id、text：不对时 400；end 没有请求体", async () => {
		const harness = await start();
		const send = (path: string, body?: string) =>
			fetch(`${harness.url}/sessions/${crypto.randomUUID()}/${path}`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${SECRET}`,
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				body,
			});
		for (const body of [
			undefined,
			"{}",
			'{"turn":1,"text":"x"}',
			`{"turn":0,"message_id":"${crypto.randomUUID()}","text":"x"}`,
			`{"turn":1,"message_id":"not-a-uuid","text":"x"}`,
		]) {
			expect((await send("steer", body)).status, String(body)).toBe(400);
		}
		expect((await send("end")).status).toBe(202);
		const bad = await fetch(`${harness.url}/sessions/not-a-uuid/end`, {
			method: "POST",
			headers: { authorization: `Bearer ${SECRET}` },
		});
		expect(bad.status).toBe(400);
	});
});

describe("没有一轮", () => {
	it("steer：409 no_turn_running", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		const res = await harness.steer(id, "插话");
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ code: "no_turn_running" });
		await harness.prompt(id, { text: "settle" });
		await harness.turnEnd(id);
		const after = await harness.steer(id, "做完之后的插话");
		expect(after.status).toBe(409);
	});

	it("end：202，关闭这个会话的 pi 进程（关 stdin），会话目录留着；重复的、不认识的会话也是 202", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "settle" });
		await harness.turnEnd(id);
		expect(harness.sessions.pid(id)).toBeDefined();
		expect((await harness.end(id)).status).toBe(202);
		await eventually(() => expect(harness.sessions.activeProcesses).toBe(0));
		await eventually(() => expect(rawTypes(harness, id)).toContain("fake_stdin_closed"));
		expect(existsSync(join(harness.dataDir, "sessions", id, "events.jsonl"))).toBe(true);
		expect((await harness.end(id)).status).toBe(202);
		expect((await harness.end(crypto.randomUUID())).status).toBe(202);
		// end 不动中止记号，也不记着收到过 end：之后轮次更大的 prompt 照常做。
		await harness.prompt(id, { turn: 2, text: "settle" });
		expect(await harness.turnEnd(id, 2)).toMatchObject({ outcome: "completed" });
	});
});

describe("关闭空闲的进程", () => {
	it("end：关 stdin 之后不退出的 pi，宽限到了被 SIGKILL", async () => {
		const clock = new ManualClock();
		const harness = await start({ clock });
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "settle-stubborn" });
		await harness.turnEnd(id);
		await harness.end(id);
		await eventually(() => expect(rawTypes(harness, id)).toContain("fake_stdin_closed"));
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(harness.sessions.activeProcesses).toBe(1);
		clock.advance(ASSISTANT_PROCESS_KILL_GRACE_MS);
		await eventually(() => expect(harness.sessions.activeProcesses).toBe(0));
	});
});

describe("在做", () => {
	it("steer：收下（202），先发一份含它的 steer_queue；送到之后发不含它的 steer_queue；不发 steer_dropped", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "deliver-two" });
		await started(harness, id);
		const first = crypto.randomUUID();
		const second = crypto.randomUUID();
		expect((await harness.steer(id, "先别改测试", 1, first)).status).toBe(202);
		expect((await harness.steer(id, "顺便看一下日志", 1, second)).status).toBe(202);
		await eventually(() => {
			const queues = eventsOf(harness, id).filter((e) => e.type === "steer_queue");
			expect(queues.at(-1)).toEqual({ type: "steer_queue", messages: [] });
		});
		const queues = eventsOf(harness, id).flatMap((e) =>
			e.type === "steer_queue" ? [e.messages.map((m) => m.message_id)] : [],
		);
		// 收下第一句时就有一份含它的；每份都是还没送到的完整列表。
		expect(queues[0]).toEqual([first]);
		expect(queues).toContainEqual([first, second]);
		expect(queues.at(-1)).toEqual([]);
		// 两句按收到的顺序各交给 pi 一次。
		expect(rawEvents(harness, id).filter((r) => r.type === "queue_update").length).toBeGreaterThan(
			0,
		);
		await harness.abort(id);
		await harness.turnEnd(id);
		expect(kinds(eventsOf(harness, id))).not.toContain("notice:steer_dropped");
	});

	it("steer：轮次不是在做的那一轮 409；同一个 message_id 再来只算一次", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "hang" });
		await started(harness, id);
		expect((await harness.steer(id, "错的轮次", 2)).status).toBe(409);
		const same = crypto.randomUUID();
		expect((await harness.steer(id, "一句", 1, same)).status).toBe(202);
		expect((await harness.steer(id, "一句", 1, same)).status).toBe(202);
		await eventually(() => expect(rawTypes(harness, id)).toContain("queue_update"));
		await new Promise((resolve) => setTimeout(resolve, 300));
		// 只交给 pi 一次，只发过一份 steer_queue，里面只有一条。
		expect(rawEvents(harness, id).filter((r) => r.type === "queue_update")).toHaveLength(1);
		const queues = eventsOf(harness, id).filter((e) => e.type === "steer_queue");
		expect(queues).toEqual([
			{ type: "steer_queue", messages: [{ message_id: same, text: "一句" }] },
		]);
	});

	it("abort：先 clear_queue、后 abort（接连写出），pi 报告 agent_settled 就以 stopped 结束、进程留着；没送到的插话各发 steer_dropped、在 turn_end 前面，决定结束之后不再发 steer_queue；下一轮交 prompt 之前先 clear_queue", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "hang" });
		await started(harness, id);
		const steer = crypto.randomUUID();
		await harness.steer(id, "这句不会送到", 1, steer);
		await eventually(() => expect(rawTypes(harness, id)).toContain("queue_update"));
		const pid = harness.sessions.pid(id);
		expect((await harness.abort(id)).status).toBe(202);
		expect(await harness.turnEnd(id)).toMatchObject({
			outcome: "stopped",
			reason: "用户停止了这一轮",
		});
		const raw = rawTypes(harness, id);
		expect(raw).toContain("fake_clear_queue");
		expect(raw.indexOf("fake_clear_queue")).toBeLessThan(raw.indexOf("fake_abort"));
		const events = eventsOf(harness, id, 1);
		const dropped = events.filter((e) => e.type === "notice" && e.kind === "steer_dropped");
		expect(dropped).toEqual([
			expect.objectContaining({ message_id: steer, message: "插话「这句不会送到」没有送到" }),
		]);
		expect(kinds(events).slice(-2)).toEqual(["notice:steer_dropped", "turn_end"]);
		// 进程留着，下一轮接着用：交 prompt 之前先 clear_queue 一次。
		expect(harness.sessions.pid(id)).toBe(pid);
		const clears = rawTypes(harness, id).filter((t) => t === "fake_clear_queue").length;
		await harness.prompt(id, { turn: 2, text: "settle" });
		expect(await harness.turnEnd(id, 2)).toMatchObject({ outcome: "completed" });
		expect(harness.sessions.pid(id)).toBe(pid);
		await eventually(() =>
			expect(rawTypes(harness, id).filter((t) => t === "fake_clear_queue").length).toBe(clears + 1),
		);
		const after = rawTypes(harness, id);
		expect(after.lastIndexOf("fake_clear_queue")).toBeLessThan(after.lastIndexOf("turn_start"));
	});

	it("end：照停止结束这一轮（stopped，会话结束了），turn_end 发出之后关闭 pi 进程", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "hang" });
		await started(harness, id);
		expect((await harness.end(id)).status).toBe(202);
		expect(await harness.turnEnd(id)).toMatchObject({ outcome: "stopped", reason: "会话结束了" });
		await eventually(() => expect(rawTypes(harness, id)).toContain("fake_stdin_closed"));
		const raw = rawTypes(harness, id);
		expect(raw.indexOf("fake_abort")).toBeLessThan(raw.indexOf("fake_stdin_closed"));
		await eventually(() => expect(harness.sessions.activeProcesses).toBe(0));
	});

	it("prompt 先看记号、再看在做：第 2 轮在做时晚到的第 1 轮（轮次不大于记号）回 202、以 stopped 结束，不回 409，第 2 轮不受影响", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		// 控制面放弃了第 1 轮（abort 1），之后开始了第 2 轮；第 1 轮的 prompt 这时才到。
		await harness.abort(id, 1);
		await harness.prompt(id, { turn: 2, text: "hang" });
		await started(harness, id);
		const late = await harness.prompt(id, { turn: 1, text: "settle" });
		expect(late.status).toBe(202);
		expect(await harness.turnEnd(id, 1)).toMatchObject({ outcome: "stopped", model_calls: 0 });
		// 轮次比记号大的才看在做：409。
		expect((await harness.prompt(id, { turn: 3, text: "settle" })).status).toBe(409);
		expect(eventsOf(harness, id, 2).some((e) => e.type === "turn_end")).toBe(false);
		await harness.abort(id, 2);
		expect(await harness.turnEnd(id, 2)).toMatchObject({ outcome: "stopped" });
	});

	it("新起的 pi 先把插话设成一次全送，再交 prompt", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "settle" });
		await harness.turnEnd(id);
		await eventually(() => expect(rawTypes(harness, id)).toContain("turn_start"));
		const raw = rawEvents(harness, id);
		expect(raw.find((r) => r.type === "fake_steering_mode")).toMatchObject({ mode: "all" });
		const types = raw.map((r) => r.type);
		expect(types.indexOf("fake_steering_mode")).toBeLessThan(types.indexOf("turn_start"));
	});
});

describe("插话的不变式：每句收下的插话在 turn_end 之前要么送到，要么有它的 steer_dropped", () => {
	it("这一轮做完了（agent_settled）而插话还在 pi 的队列里：steer_dropped（没有送到）在 turn_end 前面", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "done-on-steer" });
		await started(harness, id);
		const steer = crypto.randomUUID();
		await harness.steer(id, "来不及的插话", 1, steer);
		expect(await harness.turnEnd(id)).toMatchObject({ outcome: "completed" });
		const events = eventsOf(harness, id, 1);
		expect(kinds(events).slice(-2)).toEqual(["notice:steer_dropped", "turn_end"]);
		expect(events.at(-2)).toMatchObject({
			message_id: steer,
			message: "插话「来不及的插话」没有送到",
		});
	});

	it("pi 进程在插话交出去之后退出：steer_dropped（没有确认送到）在 interrupted 前面", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "quit-on-steer" });
		await started(harness, id);
		const steer = crypto.randomUUID();
		await harness.steer(id, "进程退出前的插话", 1, steer);
		expect(await harness.turnEnd(id)).toMatchObject({ outcome: "interrupted" });
		const events = eventsOf(harness, id, 1);
		expect(kinds(events).slice(-2)).toEqual(["notice:steer_dropped", "turn_end"]);
		expect(events.at(-2)).toMatchObject({
			message_id: steer,
			message: "插话「进程退出前的插话」没有确认送到",
		});
	});

	it("disposition 是 handled（被扩展处理了）或者 pi 没收下：马上发 steer_dropped，之后再发不含它的 steer_queue", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "hang" });
		await started(harness, id);
		const handled = crypto.randomUUID();
		const refused = crypto.randomUUID();
		expect((await harness.steer(id, "HANDLE 吃掉", 1, handled)).status).toBe(202);
		expect((await harness.steer(id, "REFUSE 不收", 1, refused)).status).toBe(202);
		await eventually(() =>
			expect(
				eventsOf(harness, id).filter((e) => e.type === "notice" && e.kind === "steer_dropped"),
			).toHaveLength(2),
		);
		const events = eventsOf(harness, id);
		for (const [messageId, why] of [
			[handled, "被扩展处理了，没有送到模型"],
			[refused, "pi 没有收下，没有送到"],
		] as const) {
			const at = events.findIndex(
				(e) => e.type === "notice" && e.kind === "steer_dropped" && e.message_id === messageId,
			);
			expect(events[at]).toMatchObject({ message: expect.stringContaining(why) });
			// 它之后的那份 steer_queue 里没有它，之前的最后一份有它（消失之前先有 steer_dropped）。
			const before = events
				.slice(0, at)
				.filter((e) => e.type === "steer_queue")
				.at(-1);
			expect(
				before?.type === "steer_queue" && before.messages.some((m) => m.message_id === messageId),
			).toBe(true);
			const next = events.slice(at + 1).find((e) => e.type === "steer_queue");
			expect(
				next?.type === "steer_queue" && next.messages.some((m) => m.message_id === messageId),
			).toBe(false);
		}
		await harness.abort(id);
		await harness.turnEnd(id);
		// 已经发过 steer_dropped 的不再发第二次。
		expect(
			eventsOf(harness, id).filter((e) => e.type === "notice" && e.kind === "steer_dropped"),
		).toHaveLength(2);
	});
});

describe("在停止、在停止又有一轮在等（pi 不理 abort，要结束进程才停得下）", () => {
	it("在停止：steer 409；abort 不改变什么；prompt 登记、202，等旧的一轮的 turn_end 之后才开始，在等的那一轮的插话收下、开始之后交给 pi", async () => {
		const harness = await start({ abortSettleMs: 400, killGraceMs: 400 });
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "deaf" });
		await started(harness, id);
		expect((await harness.abort(id, 1)).status).toBe(202);
		// 在停止（第 1 轮）。
		expect((await harness.steer(id, "迟到的插话", 1)).status).toBe(409);
		expect((await harness.abort(id, 1)).status).toBe(202);
		expect((await harness.prompt(id, { turn: 2, text: "deliver-then-settle" })).status).toBe(202);
		// 在停止、第 2 轮在等。
		expect((await harness.prompt(id, { turn: 3, text: "settle" })).status).toBe(409);
		expect((await harness.steer(id, "对第 1 轮说的", 1)).status).toBe(409);
		const waiting = crypto.randomUUID();
		expect((await harness.steer(id, "对第 2 轮说的", 2, waiting)).status).toBe(202);
		expect(eventsOf(harness, id, 2).filter((e) => e.type === "turn_end")).toEqual([]);
		expect(await harness.turnEnd(id, 1)).toMatchObject({ outcome: "stopped" });
		const end2 = await harness.turnEnd(id, 2);
		expect(end2).toMatchObject({ outcome: "completed" });
		// 第 2 轮在第 1 轮的 turn_end 之后才开始；它的插话开始之后才交给 pi、送到了。
		const order = harness.events
			.of(id)
			.filter((r) => r.event.type === "turn_end")
			.map((r) => r.turn);
		expect(order).toEqual([1, 2]);
		expect(kinds(eventsOf(harness, id, 2))).not.toContain("notice:steer_dropped");
		expect(
			eventsOf(harness, id, 2)
				.filter((e) => e.type === "steer_queue")
				.at(-1),
		).toEqual({
			type: "steer_queue",
			messages: [],
		});
	});

	it("在停止又有一轮在等：abort 带在等的那一轮的轮次，它立即 stopped（不起 pi），它的插话各发 steer_dropped、在它的 turn_end 前面；状态回到在停止，之后的 prompt 照常登记", async () => {
		const harness = await start({ abortSettleMs: 400, killGraceMs: 400 });
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "deaf" });
		await started(harness, id);
		await harness.abort(id, 1);
		await harness.prompt(id, { turn: 2, text: "settle" });
		const held = crypto.randomUUID();
		await harness.steer(id, "在等时说的", 2, held);
		expect((await harness.abort(id, 2)).status).toBe(202);
		const end2 = await harness.turnEnd(id, 2);
		expect(end2).toMatchObject({ outcome: "stopped", model_calls: 0 });
		const events2 = eventsOf(harness, id, 2);
		expect(kinds(events2).slice(-2)).toEqual(["notice:steer_dropped", "turn_end"]);
		expect(events2.at(-2)).toMatchObject({
			message_id: held,
			message: "插话「在等时说的」没有送到",
		});
		// 第 1 轮还在停止：它的结局在第 2 轮之后。
		expect(eventsOf(harness, id, 1).some((e) => e.type === "turn_end")).toBe(false);
		expect((await harness.prompt(id, { turn: 3, text: "settle" })).status).toBe(202);
		expect(await harness.turnEnd(id, 1)).toMatchObject({ outcome: "stopped" });
		expect(await harness.turnEnd(id, 3)).toMatchObject({ outcome: "completed" });
	});

	it("在停止又有一轮在等：end 让在等的那一轮立即 stopped；在停止的那一轮照常停完，它的 turn_end 发出之后关闭进程", async () => {
		const harness = await start({ abortSettleMs: 400, killGraceMs: 400 });
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "deaf" });
		await started(harness, id);
		await harness.abort(id, 1);
		await harness.prompt(id, { turn: 2, text: "settle" });
		expect((await harness.end(id)).status).toBe(202);
		expect(await harness.turnEnd(id, 2)).toMatchObject({
			outcome: "stopped",
			reason: "会话结束了",
		});
		expect(await harness.turnEnd(id, 1)).toMatchObject({ outcome: "stopped" });
		await eventually(() => expect(harness.sessions.activeProcesses).toBe(0));
		// 第 2 轮没有开始：pi 只拿到过第 1 轮的 prompt。
		expect(rawEvents(harness, id).filter((r) => r.type === "turn_start")).toHaveLength(1);
	});

	it("在停止：end 不打断它，第 1 轮照常停完，turn_end 发出之后关闭进程（这里进程本来就要结束）", async () => {
		const harness = await start({ abortSettleMs: 400, killGraceMs: 400 });
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "deaf" });
		await started(harness, id);
		await harness.abort(id, 1);
		expect((await harness.end(id)).status).toBe(202);
		expect(await harness.turnEnd(id, 1)).toMatchObject({
			outcome: "stopped",
			reason: "用户停止了这一轮",
		});
		await eventually(() => expect(harness.sessions.activeProcesses).toBe(0));
	});
});

describe("停止的时间（手动推进的时钟，从决定结束的那一刻 T0 起算）", () => {
	it("pi 不理 abort：T0 加 10 秒之前不结束进程，到点关 stdin、SIGTERM，进程退出之后以 stopped 结束，在 15 秒之内", async () => {
		const clock = new ManualClock();
		const harness = await start({ clock });
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "deaf" });
		await started(harness, id);
		await harness.abort(id);
		const t0 = clock.now();
		await eventually(() => expect(rawTypes(harness, id)).toContain("fake_abort"));
		clock.advance(ASSISTANT_ABORT_SETTLE_MS - 1);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(rawTypes(harness, id)).not.toContain("fake_stdin_closed");
		expect(eventsOf(harness, id).some((e) => e.type === "turn_end")).toBe(false);
		clock.advance(1);
		const end = await harness.turnEnd(id);
		expect(end).toMatchObject({ outcome: "stopped" });
		expect(clock.now() - t0).toBeLessThanOrEqual(15_000);
		expect(end.duration_ms).toBeGreaterThanOrEqual(ASSISTANT_ABORT_SETTLE_MS);
	});

	it("pi 不理 abort 也不理 SIGTERM：T0 加 10 秒 SIGTERM，再 10 秒 SIGKILL，进程被结束，这一轮以 stopped 结束（10 加 10 秒之内）", async () => {
		const clock = new ManualClock();
		const harness = await start({ clock });
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "ignore-term" });
		await started(harness, id);
		await harness.abort(id);
		const t0 = clock.now();
		clock.advance(ASSISTANT_ABORT_SETTLE_MS);
		await eventually(() => expect(rawTypes(harness, id)).toContain("fake_ignored_sigterm"));
		expect(harness.sessions.activeProcesses).toBe(1);
		clock.advance(ASSISTANT_PROCESS_KILL_GRACE_MS);
		const end = await harness.turnEnd(id);
		expect(end).toMatchObject({ outcome: "stopped" });
		expect(clock.now() - t0).toBe(ASSISTANT_ABORT_SETTLE_MS + ASSISTANT_PROCESS_KILL_GRACE_MS);
		await eventually(() => expect(harness.sessions.activeProcesses).toBe(0));
	});

	it("硬上限：SIGKILL 发出之后进程还没退出时，到 T0 加 23 秒照样发 turn_end；在等的那一轮同一时刻以 failed 结束", async () => {
		const clock = new ManualClock();
		const harness = await start({ clock });
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "ignore-term" });
		await started(harness, id);
		await harness.abort(id);
		await harness.prompt(id, { turn: 2, text: "settle" });
		clock.advance(ASSISTANT_ABORT_SETTLE_MS);
		await eventually(() => expect(rawTypes(harness, id)).toContain("fake_ignored_sigterm"));
		// 同一次推进里先发 SIGKILL、再到硬上限：进程的退出在事件循环里，还没轮到，算「SIGKILL 之后还没退出」。
		clock.advance(ASSISTANT_STOP_WAIT_MS - ASSISTANT_ABORT_SETTLE_MS);
		expect(await harness.turnEnd(id, 1)).toMatchObject({ outcome: "stopped" });
		expect(await harness.turnEnd(id, 2)).toMatchObject({
			outcome: "failed",
			reason: "上一轮（第 1 轮）的 pi 进程没有退出，所以这一轮没有开始",
		});
		const ends = harness.events.of(id).filter((r) => r.event.type === "turn_end");
		expect(ends.map((r) => r.turn)).toEqual([1, 2]);
		await eventually(() => expect(harness.sessions.activeProcesses).toBe(0));
	});
});

describe("#677 审查补的", () => {
	/** pi 原始事件里的用户消息的文字（pi 实际放进对话的）。 */
	const userTexts = (harness: Harness, id: string): string[] =>
		rawEvents(harness, id).flatMap((r) => {
			const m = r.message as { role?: string; content?: Array<{ text?: string }> } | undefined;
			return r.type === "message_end" && m?.role === "user"
				? [(m.content ?? []).map((c) => c.text ?? "").join("")]
				: [];
		});
	const droppedIds = (events: AssistantEvent[]) =>
		events.flatMap((e) =>
			e.type === "notice" && e.kind === "steer_dropped" ? [e.message_id] : [],
		);

	it("两句插话：第一句在 pi 的队列里被 clear_queue 取走，第二句清空之后才进队列、收尾时进了对话：第一句有 steer_dropped，第二句算送到（clear_queue 回了 k 条，前 k 句没有送到）", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "race2" });
		await started(harness, id);
		const a = crypto.randomUUID();
		const b = crypto.randomUUID();
		expect((await harness.steer(id, "A 第一句", 1, a)).status).toBe(202);
		await eventually(() => expect(rawTypes(harness, id)).toContain("queue_update"));
		expect((await harness.steer(id, "SLOW B 第二句", 1, b)).status).toBe(202);
		expect((await harness.abort(id)).status).toBe(202);
		expect(await harness.turnEnd(id)).toMatchObject({ outcome: "stopped" });
		await eventually(() => expect(rawTypes(harness, id)).toContain("agent_settled"));
		// 实情：A 被 clear_queue 取走，B 进了对话。
		expect(rawEvents(harness, id).find((r) => r.type === "fake_clear_queue")).toMatchObject({
			steering: ["A 第一句"],
		});
		expect(userTexts(harness, id)).toContain("SLOW B 第二句");
		expect(userTexts(harness, id)).not.toContain("A 第一句");
		const events = eventsOf(harness, id, 1);
		expect(droppedIds(events)).toEqual([a]);
	});

	it("上一轮正常做完、插话还留在 pi 的队列里（已经写了没有送到）：下一轮交 prompt 之前清掉，它不会被送给模型", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "done-on-steer" });
		await started(harness, id);
		const steer = crypto.randomUUID();
		await harness.steer(id, "留在队列里的插话", 1, steer);
		await harness.turnEnd(id);
		expect(droppedIds(eventsOf(harness, id, 1))).toEqual([steer]);
		// 下一轮一开始就会把队列里还有的插话送到模型（像真的 pi 那样）：先清过了，就没有可送的。
		await harness.prompt(id, { turn: 2, text: "flush-settle" });
		expect(await harness.turnEnd(id, 2)).toMatchObject({ outcome: "completed" });
		await eventually(() =>
			expect(rawEvents(harness, id).filter((r) => r.type === "agent_settled")).toHaveLength(2),
		);
		expect(
			rawEvents(harness, id)
				.filter((r) => r.type === "fake_clear_queue")
				.at(-1),
		).toMatchObject({
			steering: ["留在队列里的插话"],
		});
		expect(userTexts(harness, id)).not.toContain("留在队列里的插话");
	});

	it("在停止（pi 会停下、进程本来留着）时收到 end：这一轮的 turn_end 之后关闭 pi 进程", async () => {
		const harness = await start();
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "slow-abort" });
		await started(harness, id);
		expect((await harness.abort(id)).status).toBe(202);
		expect((await harness.end(id)).status).toBe(202);
		expect(await harness.turnEnd(id)).toMatchObject({ outcome: "stopped" });
		await eventually(() => expect(harness.sessions.activeProcesses).toBe(0));
		expect(rawTypes(harness, id)).toContain("fake_stdin_closed");
	});

	it("中止记号十分钟没有被提高就过期：不提高的 abort 不续期，提高的续期", async () => {
		const clock = new ManualClock();
		const harness = await start({ clock });
		const id = crypto.randomUUID();
		harness.sessions.abort(id, 5);
		clock.advance(9 * 60_000);
		harness.sessions.abort(id, 3); // 不提高
		clock.advance(60_000 + 1_000);
		await harness.prompt(id, { turn: 4, text: "settle" });
		expect(await harness.turnEnd(id, 4)).toMatchObject({ outcome: "completed" });
		const other = crypto.randomUUID();
		harness.sessions.abort(other, 5);
		clock.advance(9 * 60_000);
		harness.sessions.abort(other, 6); // 提高
		clock.advance(2 * 60_000);
		await harness.prompt(other, { turn: 6, text: "settle" });
		expect(await harness.turnEnd(other, 6)).toMatchObject({ outcome: "stopped", model_calls: 0 });
	});

	it("进程数到了上限：在停止的一轮的进程不算空闲、不被关掉，新会话 503", async () => {
		const harness = await start({ maxProcesses: 1, abortSettleMs: 1_500, killGraceMs: 300 });
		const a = crypto.randomUUID();
		await harness.prompt(a, { text: "deaf" });
		await started(harness, a);
		await harness.abort(a);
		const res = await harness.prompt(crypto.randomUUID(), { text: "settle" });
		expect(res.status).toBe(503);
		expect(await res.json()).toMatchObject({ code: "process_limit" });
		expect(await harness.turnEnd(a)).toMatchObject({ outcome: "stopped" });
	});

	describe("往刚退出的 pi 写命令（pi 退出了、助手服务还没收到它退出）：助手服务不退出，这一轮按进程退出收尾", () => {
		/** 等假 pi 关掉自己（它的子进程还拿着标准输出，助手服务还没发现）。 */
		const destroyed = (harness: Harness, id: string) =>
			eventually(() => expect(rawTypes(harness, id)).toContain("fake_stdin_destroyed"));

		it("steer：202，这句话之后写「没有确认送到」，这一轮 interrupted", async () => {
			const harness = await start();
			const id = crypto.randomUUID();
			await harness.prompt(id, { text: "close-stdin" });
			await destroyed(harness, id);
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(harness.sessions.pid(id)).toBeDefined();
			const steer = crypto.randomUUID();
			expect((await harness.steer(id, "写不进去的插话", 1, steer)).status).toBe(202);
			const end = await harness.turnEnd(id, 1, 15_000);
			expect(end).toMatchObject({ outcome: "interrupted" });
			expect(eventsOf(harness, id, 1).at(-2)).toMatchObject({
				message_id: steer,
				message: "插话「写不进去的插话」没有确认送到",
			});
		});

		it("abort（写 clear_queue、abort）：202，这一轮 stopped", async () => {
			const harness = await start({ abortSettleMs: 300, killGraceMs: 300 });
			const id = crypto.randomUUID();
			await harness.prompt(id, { text: "close-stdin" });
			await destroyed(harness, id);
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect((await harness.abort(id)).status).toBe(202);
			expect(await harness.turnEnd(id, 1, 15_000)).toMatchObject({ outcome: "stopped" });
		});

		it("下一轮交 prompt 之前的 clear_queue：202，这一轮 interrupted", async () => {
			const harness = await start();
			const id = crypto.randomUUID();
			await harness.prompt(id, { text: "settle-then-die" });
			expect(await harness.turnEnd(id)).toMatchObject({ outcome: "completed" });
			await destroyed(harness, id);
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(harness.sessions.pid(id)).toBeDefined();
			expect((await harness.prompt(id, { turn: 2, text: "settle" })).status).toBe(202);
			expect(await harness.turnEnd(id, 2, 15_000)).toMatchObject({ outcome: "interrupted" });
			// 进程退出之后，会话还能接着说。
			await harness.prompt(id, { turn: 3, text: "settle" });
			expect(await harness.turnEnd(id, 3)).toMatchObject({ outcome: "completed" });
		});
	});

	it("停止时 pi 恰好拒绝了这句话：不等 agent_settled、不结束进程，直接以 stopped 结束", async () => {
		const clock = new ManualClock();
		const harness = await start({ clock });
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "reject-slow" });
		await eventually(() => expect(rawTypes(harness, id)).toContain("fake_prompt_received"));
		const pid = harness.sessions.pid(id);
		await harness.abort(id);
		// 时钟不动：不靠 10 秒的等待。
		expect(await harness.turnEnd(id)).toMatchObject({ outcome: "stopped" });
		expect(harness.sessions.pid(id)).toBe(pid);
	});

	it("硬上限到了、SIGKILL 之后还没退出的旧进程不复用：再来一轮等它退出，起新的进程做完", async () => {
		const clock = new ManualClock();
		const harness = await start({ clock });
		const id = crypto.randomUUID();
		await harness.prompt(id, { text: "ignore-term" });
		await started(harness, id);
		const old = harness.sessions.pid(id);
		await harness.abort(id);
		clock.advance(ASSISTANT_ABORT_SETTLE_MS);
		await eventually(() => expect(rawTypes(harness, id)).toContain("fake_ignored_sigterm"));
		clock.advance(ASSISTANT_STOP_WAIT_MS - ASSISTANT_ABORT_SETTLE_MS);
		// 同一个时刻（旧进程的退出还在事件循环里，没轮到）就来了第 2 轮：不能复用它。
		const result = harness.sessions.prompt(id, {
			turn: 2,
			message_id: crypto.randomUUID(),
			text: "settle",
			session: { title: "测试", created_by: "tester" },
			workbench: {
				name: "fake-workbench",
				address: harness.workbench.address,
				workdir: harness.workdir,
			},
			env: {},
			secret_env: {},
		});
		expect(result).toEqual({ ok: true });
		expect(await harness.turnEnd(id, 1)).toMatchObject({ outcome: "stopped" });
		expect(await harness.turnEnd(id, 2)).toMatchObject({ outcome: "completed" });
		const now = harness.sessions.pid(id);
		expect(now).toBeDefined();
		expect(now).not.toBe(old);
		// 第 2 轮的 prompt 交给了新的进程（旧的那个只拿到过第 1 轮的）。
		const starts = rawEvents(harness, id).filter((r) => r.type === "fake_env");
		expect(starts).toHaveLength(2);
	});
});
