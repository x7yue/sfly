// 会话事件流的「补发加实时」（src/sessions/follow.ts）：用假的数据源控制补发的节奏，让补发和实时真的重叠。
// 保证：持久的事件不重不漏；不持久的事件不跑到它之后的持久事件后面；慢客户端不会把整段历史顶进内存。
import type { PersistedSessionEvent, SessionEvent } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	type FollowOptions,
	FollowOverflowError,
	type FollowSink,
	type FollowSource,
	follow,
} from "../src/sessions/follow.js";

const AT = "2026-01-01T00:00:00.000Z";
const persistent = (seq: number): PersistedSessionEvent => ({
	type: "turn_started",
	turn: seq,
	seq,
	at: AT,
});
const delta = (text: string): SessionEvent => ({ type: "assistant_delta", text });
/** 助手的一条完整消息（取代它之前的文字增量）、用户的插话、工具的输出和结果：只带这里用到的字段。 */
const persistentOf = (seq: number, body: Record<string, unknown>): PersistedSessionEvent =>
	({ ...body, seq, at: AT }) as unknown as PersistedSessionEvent;
const message = (seq: number) =>
	persistentOf(seq, { type: "assistant_message", text: "完整的消息" });
const steerMessage = (seq: number) =>
	persistentOf(seq, { type: "user_message", text: "先别改测试", steer: true });
const toolResult = (seq: number, callId: string) =>
	persistentOf(seq, { type: "tool_result", call_id: callId, text: "结果" });
const toolOutput = (callId: string, text: string): SessionEvent => ({
	type: "tool_output",
	call_id: callId,
	text,
});

/** 一个可以停住的点：`hold()` 在 `release()` 之前不返回。 */
function gate() {
	let release = () => {};
	const opened = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { opened, release };
}

/** 假的数据源：库是一个数组，`append` 先落库再发布（和 SessionStore.append 一样），读库可以按次数停住。 */
class FakeSource implements FollowSource {
	readonly db: PersistedSessionEvent[] = [];
	readonly listeners = new Set<(event: SessionEvent) => void>();
	/** 每次读库的 `after` 参数，按次序。 */
	readonly reads: number[] = [];
	/** 第 n 次读库（从 1 起）开始前要先等的点。 */
	readonly holdRead = new Map<number, Promise<void>>();
	/** 第 n 次读库已经开始（正停在 holdRead 上）的信号。 */
	readonly readStarted = new Map<number, ReturnType<typeof gate>>();
	/** 第 n 次读库取到结果之后、返回之前做的事：模拟「读完以后、补发收尾之前」又来了实时事件。 */
	readonly afterSnapshot = new Map<number, () => void>();
	failRead: Error | undefined;

	constructor(seqs: number[] = []) {
		for (const seq of seqs) this.db.push(persistent(seq));
	}

	subscribe(listener: (event: SessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async read(after: number, limit: number): Promise<PersistedSessionEvent[]> {
		this.reads.push(after);
		const n = this.reads.length;
		this.readStarted.get(n)?.release();
		await this.holdRead.get(n);
		if (this.failRead) throw this.failRead;
		const snapshot = this.db.filter((event) => event.seq > after).slice(0, limit);
		this.afterSnapshot.get(n)?.();
		return snapshot;
	}

	publish(event: SessionEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}

	append(seq: number, event: PersistedSessionEvent = persistent(seq)): PersistedSessionEvent {
		this.db.push(event);
		this.publish(event);
		return event;
	}

	/** 在第 n 次读库前停住；返回放行的函数和「这次读库已经开始」的信号。 */
	hold(n: number) {
		const lock = gate();
		this.holdRead.set(n, lock.opened);
		const started = gate();
		this.readStarted.set(n, started);
		return { release: lock.release, started: started.opened };
	}
}

/** 假的出口：`drained` 默认马上完成，可以按次数停住。 */
class FakeSink implements FollowSink {
	readonly out: SessionEvent[] = [];
	drainCalls = 0;
	readonly holdDrain = new Map<number, Promise<void>>();

	emit(event: SessionEvent): void {
		this.out.push(event);
	}

	async drained(): Promise<void> {
		this.drainCalls += 1;
		await this.holdDrain.get(this.drainCalls);
	}

	hold(n: number) {
		const lock = gate();
		this.holdDrain.set(n, lock.opened);
		return lock.release;
	}

	/** 出口收到的东西，持久的写序号、其余写类型（增量和工具输出写文字）。 */
	get shape(): string[] {
		return this.out.map((event) =>
			"seq" in event
				? String(event.seq)
				: event.type === "assistant_delta" || event.type === "tool_output"
					? event.text
					: event.type,
		);
	}
}

const settle = async (turns = 5) => {
	for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
};

const run = (
	source: FakeSource,
	sink: FakeSink,
	options: FollowOptions = { batch: 2 },
	after = 0,
): { stop: () => void; errors: unknown[] } => {
	const errors: unknown[] = [];
	const stop = follow(source, after, sink, (error) => errors.push(error), options);
	return { stop, errors };
};

describe("补发和实时重叠：持久的事件不重不漏，不持久的事件不跑到它之后的持久事件后面", () => {
	it("补发的最后一次读库之前来了实时事件：补发读到的持久事件不重复；它们前面的增量已经过时，丢掉；后面的增量留下", async () => {
		const source = new FakeSource([1, 2, 3, 4]);
		const sink = new FakeSink();
		const third = source.hold(3);
		const { errors } = run(source, sink);
		// 补发读完前两批（1、2 和 3、4）停在第三次读库：这时才有实时事件进来。
		await third.started;
		expect(sink.shape).toEqual(["1", "2", "3", "4"]);
		source.publish(delta("过时的增量")); // 在 5（完整的消息）之前：5 的完整内容里已经有它
		source.append(5, message(5)); // 落库、发布；第三次读库会读到它
		source.publish(delta("新的增量")); // 在 5 之后：还没有落库的完整内容，要留下
		third.release();
		await settle();
		expect(source.reads).toEqual([0, 2, 4]);
		expect(sink.shape).toEqual(["1", "2", "3", "4", "5", "新的增量"]);
		expect(errors).toEqual([]);
	});

	it("一条进行中的消息的增量前后夹着一条插话（user_message）：前半截增量不能丢，页面上这条消息要是完整的（#544）", async () => {
		const source = new FakeSource([1, 2, 3, 4]);
		const sink = new FakeSink();
		const third = source.hold(3);
		const { errors } = run(source, sink);
		await third.started;
		source.publish(delta("前半截，"));
		source.append(5, steerMessage(5)); // 用户插话：落在这条消息的增量中间；第三次读库会读到它
		source.publish(delta("后半截"));
		third.release();
		await settle();
		// 插话不带这条消息的内容，取代不了增量：两段增量都留下，按到达的先后。
		expect(sink.shape).toEqual(["1", "2", "3", "4", "5", "前半截，", "后半截"]);
		expect(errors).toEqual([]);
	});

	it("别的不带这条消息内容的持久事件也一样：提示、一轮的开始都取代不了增量", async () => {
		const source = new FakeSource([1, 2]);
		const sink = new FakeSink();
		const second = source.hold(2);
		const { errors } = run(source, sink);
		await second.started;
		source.publish(delta("前半截，"));
		source.append(3, persistentOf(3, { type: "notice", kind: "steer_dropped", message: "x" }));
		source.publish(delta("后半截"));
		source.append(4); // turn_started
		source.publish(delta("接着"));
		second.release();
		await settle();
		expect(sink.shape).toEqual(["1", "2", "3", "4", "前半截，", "后半截", "接着"]);
		expect(errors).toEqual([]);
	});

	it("完整的消息已经补发：它之前的增量和思考丢掉，它之后的留下；夹着插话时只丢完整的消息前面的", async () => {
		const source = new FakeSource([1, 2]);
		const sink = new FakeSink();
		const second = source.hold(2);
		const { errors } = run(source, sink);
		await second.started;
		source.publish({ type: "thinking" });
		source.publish(delta("A"));
		source.append(3, steerMessage(3)); // 插话夹在 A 和 B 之间
		source.publish(delta("B"));
		source.append(4, message(4)); // 完整的消息 AB 落库
		source.publish(delta("下一条的开头"));
		second.release();
		await settle();
		// A、B、思考都已经在 4 里：丢掉；下一条消息的增量留下。
		expect(sink.shape).toEqual(["1", "2", "3", "4", "下一条的开头"]);
		expect(errors).toEqual([]);
	});

	it("工具输出：同一次调用的结果已经补发就丢，别的调用的输出和还没有结果的留下", async () => {
		const source = new FakeSource([1, 2]);
		const sink = new FakeSink();
		const second = source.hold(2);
		const { errors } = run(source, sink);
		await second.started;
		source.publish(toolOutput("call_a", "a 的输出"));
		source.publish(toolOutput("call_b", "b 的输出"));
		source.append(3, toolResult(3, "call_a"));
		second.release();
		await settle();
		expect(sink.shape).toEqual(["1", "2", "3", "b 的输出"]);
		expect(errors).toEqual([]);
	});

	it("每条都是完整的当前状态的事件（steer_queue、turn_queued）按到达先后放出，不判断过时", async () => {
		const source = new FakeSource([1, 2]);
		const sink = new FakeSink();
		const second = source.hold(2);
		const { errors } = run(source, sink);
		await second.started;
		source.publish({ type: "steer_queue", messages: [] });
		source.append(3, message(3));
		source.publish({ type: "steer_queue", messages: [] });
		second.release();
		await settle();
		expect(sink.shape).toEqual(["1", "2", "3", "steer_queue", "steer_queue"]);
		expect(errors).toEqual([]);
	});

	it("补发期间实时来的持久事件不会让后面的补发跳过：下一批仍从补发读到的位置往后读", async () => {
		const source = new FakeSource([1, 2, 3, 4]);
		const sink = new FakeSink();
		// 补发第一批（1、2）之后停在 drained：这时 5 落库并发布。
		const release = sink.hold(1);
		const { errors } = run(source, sink);
		await settle();
		expect(sink.shape).toEqual(["1", "2"]);
		source.append(5);
		await settle();
		// 补发还没读下一批，实时的 5 也不能先发出去（发出去会把「已经发到哪」推到 5，后面的补发就从 5 之后读，漏掉 3、4）。
		expect(sink.shape).toEqual(["1", "2"]);
		release();
		await settle();
		expect(source.reads).toEqual([0, 2, 4]);
		expect(sink.shape).toEqual(["1", "2", "3", "4", "5"]);
		expect(errors).toEqual([]);
	});

	it("补发期间到的事件（持久的和不持久的）按到达先后缓冲，补发完按原来的相对顺序放出", async () => {
		const source = new FakeSource([1, 2]);
		const sink = new FakeSink();
		// 第二次读库（补发的最后一次）取到结果之后、返回之前：又落库了 3、4，中间夹着增量（它们都不在这次读到的结果里）。
		source.afterSnapshot.set(2, () => {
			source.publish(delta("a"));
			source.append(3);
			source.publish(delta("b"));
			source.append(4);
			source.publish(delta("c"));
		});
		const { errors } = run(source, sink);
		await settle();
		expect(source.reads).toEqual([0, 2]);
		expect(sink.shape).toEqual(["1", "2", "a", "3", "b", "4", "c"]);
		expect(errors).toEqual([]);
	});

	it("补发完以后是实时阶段：事件直接发出，持久的按序号去重", async () => {
		const source = new FakeSource([1, 2]);
		const sink = new FakeSink();
		run(source, sink);
		await settle();
		expect(sink.shape).toEqual(["1", "2"]);
		source.publish(delta("x"));
		source.append(3);
		source.publish(persistent(3)); // 重复的 3
		source.publish(persistent(2)); // 补发过的
		expect(sink.shape).toEqual(["1", "2", "x", "3"]);
	});

	it("带 after 接续：只补发它之后的，之前的不重发", async () => {
		const source = new FakeSource([1, 2, 3, 4, 5]);
		const sink = new FakeSink();
		run(source, sink, { batch: 2 }, 3);
		await settle();
		expect(source.reads[0]).toBe(3);
		expect(sink.shape).toEqual(["4", "5"]);
	});
});

describe("慢客户端：补发每发完一批等 drained，缓冲的实时事件有上限", () => {
	it("补发分批读：上一批还没被对端读走（drained 没完成），不读下一批", async () => {
		const source = new FakeSource([1, 2, 3, 4, 5]);
		const sink = new FakeSink();
		const first = sink.hold(1);
		run(source, sink);
		await settle();
		// 读了第一批、写出去，停在等对端读走：没有继续读库。
		expect(source.reads).toEqual([0]);
		expect(sink.shape).toEqual(["1", "2"]);
		first();
		await settle();
		expect(source.reads).toEqual([0, 2, 4]);
		expect(sink.shape).toEqual(["1", "2", "3", "4", "5"]);
	});

	it("补发期间缓冲的实时事件超过上限：报 FollowOverflowError、取消订阅、之后什么都不再发", async () => {
		const source = new FakeSource([1, 2, 3, 4]);
		const sink = new FakeSink();
		const release = sink.hold(1);
		const { errors } = run(source, sink, { batch: 2, maxBuffered: 3 });
		await settle();
		expect(source.listeners.size).toBe(1);
		source.publish(delta("1"));
		source.publish(delta("2"));
		source.publish(delta("3"));
		expect(errors).toEqual([]);
		// 第 4 条放不下。
		source.publish(delta("4"));
		expect(errors).toHaveLength(1);
		expect(errors[0]).toBeInstanceOf(FollowOverflowError);
		expect(source.listeners.size).toBe(0);
		const before = sink.shape;
		release();
		await settle();
		// 补发也停了：没有再读库，没有再发。
		expect(sink.shape).toEqual(before);
		expect(source.reads).toEqual([0]);
	});

	it("没有超过上限的缓冲照常放出", async () => {
		const source = new FakeSource([1, 2, 3, 4]);
		const sink = new FakeSink();
		const release = sink.hold(1);
		const { errors } = run(source, sink, { batch: 2, maxBuffered: 3 });
		await settle();
		source.publish(delta("a"));
		source.publish(delta("b"));
		source.publish(delta("c"));
		release();
		await settle();
		expect(errors).toEqual([]);
		// 三条增量都排在读到的最后一条持久事件之后（没有持久事件夹在中间），都留下。
		expect(sink.shape).toEqual(["1", "2", "3", "4", "a", "b", "c"]);
	});
});

describe("出错和取消", () => {
	it("读库出错：调用 onError、取消订阅，之后实时的事件不再发", async () => {
		const source = new FakeSource([1, 2]);
		source.failRead = new Error("库挂了");
		const sink = new FakeSink();
		const { errors } = run(source, sink);
		await settle();
		expect(errors).toHaveLength(1);
		expect(source.listeners.size).toBe(0);
		source.publish(delta("x"));
		expect(sink.out).toEqual([]);
	});

	it("取消：补发读到一半也不再发，订阅取消，不报错", async () => {
		const source = new FakeSource([1, 2, 3, 4]);
		const sink = new FakeSink();
		const second = source.hold(2);
		const { stop, errors } = run(source, sink);
		await second.started;
		stop();
		second.release();
		await settle();
		expect(sink.shape).toEqual(["1", "2"]);
		expect(source.listeners.size).toBe(0);
		expect(errors).toEqual([]);
	});
});
