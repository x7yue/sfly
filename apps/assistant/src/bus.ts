import { randomBytes } from "node:crypto";
import {
	ASSISTANT_REPLAY_BUFFER_BYTES,
	ASSISTANT_REPLAY_BUFFER_EVENTS,
	type AssistantEvent,
	type AssistantStreamHello,
	type AssistantStreamRecord,
	PERSISTED_SESSION_EVENT_TYPES,
} from "@sfly/schema";

/** 控制面最后收到的那条持久事件（`GET /events?after=` 的 `<纪元>:<序号>`）。 */
export interface StreamPosition {
	epoch: string;
	seq: number;
}

/** 续传的结果：`gap` 是 `hello.gap`，`lines` 是要先补发的持久事件（序号升序，已经是写得出去的 NDJSON 行）。 */
export interface Resumption {
	gap: boolean;
	lines: string[];
}

/**
 * 事件流（`GET /events`）：纪元（每次启动生成）、纪元内递增的序号（只给持久的事件），把事件推给连着的每一条流。
 * `at` 是事件产生的时间（助手服务的时钟），控制面原样存。
 *
 * **续传**（#545，协议见 `@sfly/schema` 的 `AssistantEventsQuery`）：内存里留最近 {@link ASSISTANT_REPLAY_BUFFER_EVENTS} 条持久的事件
 * （已经序列化好的行；序号是整个助手服务共用的，不分会话），不持久的不留；**同时行长（字节）加起来不超过 {@link ASSISTANT_REPLAY_BUFFER_BYTES}**，
 * 超过就从最早的挤出去，**挤出去的行立即释放**（槽位置空，不留到数组下一次挪动）。没有连接时产生的持久事件也进缓冲，控制面连上后补发。
 * 最坏的内存：字节上限加上数组本身（每条 8 字节的槽位，最多 `capacity + max(capacity, 1024)` 个）。
 */
export class EventBus {
	readonly epoch = randomBytes(9).toString("base64url");
	#seq = 0;
	readonly #subscribers = new Set<(line: string) => void>();
	/**
	 * 最近的持久事件，序号升序、连续；开头被挤出去的槽位置空（立即释放行），`#start` 是第一个还留着的槽位，数组隔一阵才真的挪一次
	 * （不在每条事件上都复制）。
	 */
	readonly #buffer: Array<{ seq: number; line: string } | undefined> = [];
	#start = 0;
	/** 留着的行的字节数合计。 */
	#bytes = 0;
	/** 被挤出去的事件里最大的序号（没有挤出过是 0）：`after` 小于它就说明 `after` 之后有事件被挤掉了，补不全。 */
	#evicted = 0;

	constructor(
		private readonly now: () => Date = () => new Date(),
		private readonly capacity: number = ASSISTANT_REPLAY_BUFFER_EVENTS,
		private readonly maxBytes: number = ASSISTANT_REPLAY_BUFFER_BYTES,
	) {}

	/** 事件流的第一行；`gap` 见 {@link EventBus.resume}。 */
	hello(gap = false): AssistantStreamHello {
		return { type: "hello", epoch: this.epoch, gap };
	}

	subscribe(write: (line: string) => void): () => void {
		this.#subscribers.add(write);
		return () => this.#subscribers.delete(write);
	}

	get subscribers(): number {
		return this.#subscribers.size;
	}

	/** 缓冲里现在有几条持久的事件。 */
	get buffered(): number {
		return this.#buffer.length - this.#start;
	}

	/**
	 * 数组里还引用着的行数（包括开头已经挤出去、还没挪掉的槽位）：被挤出去的行立即释放时它等于 {@link EventBus.buffered}。测试用，
	 * 遍历整个数组，不要在热路径上调。
	 */
	get retainedLines(): number {
		return this.#buffer.reduce((count, entry) => count + (entry === undefined ? 0 : 1), 0);
	}

	/** 缓冲里留着的行的字节数合计（不超过构造时的字节上限，除非只有这一条）。 */
	get bufferedBytes(): number {
		return this.#bytes;
	}

	/**
	 * 控制面带着 `after` 连上来：要不要补发、补发哪些、`hello.gap` 是什么（规则见协议的 `AssistantEventsQuery`）。
	 * **和订阅实时的事件在同一步里做**（调用方在同一个同步段里调用它和 {@link EventBus.subscribe}）：补发的最后一条和订阅之后的
	 * 第一条实时事件之间不漏、不重。
	 */
	resume(after: StreamPosition | undefined): Resumption {
		if (after === undefined) return { gap: false, lines: [] };
		if (after.epoch !== this.epoch || after.seq > this.#seq) return { gap: true, lines: [] };
		// `after` 之后的事件有被挤出去的（挤出去的最大序号比 `after` 还大）：补不全。按「挤出去的最大序号」判，不看缓冲里最早的一条：
		// 缓冲被字节上限挤空时（一条事件比上限还大）也对。
		if (this.#evicted > after.seq) return { gap: true, lines: [] };
		const lines: string[] = [];
		for (let index = this.#start; index < this.#buffer.length; index++) {
			const entry = this.#buffer[index];
			if (entry !== undefined && entry.seq > after.seq) lines.push(entry.line);
		}
		return { gap: false, lines };
	}

	emit(sessionId: string, turn: number, event: AssistantEvent): AssistantStreamRecord {
		const persisted = (PERSISTED_SESSION_EVENT_TYPES as readonly string[]).includes(event.type);
		const record: AssistantStreamRecord = {
			epoch: this.epoch,
			...(persisted && { seq: ++this.#seq }),
			session_id: sessionId,
			turn,
			at: this.now().toISOString(),
			event,
		};
		const line = `${JSON.stringify(record)}\n`;
		if (persisted) this.#remember(this.#seq, line);
		for (const write of this.#subscribers) write(line);
		return record;
	}

	#remember(seq: number, line: string): void {
		this.#buffer.push({ seq, line });
		this.#bytes += Buffer.byteLength(line);
		// 条数和字节数谁先到按谁：从最早的挤，立即释放（槽位置空）；一条比字节上限还大的事件也会把自己挤出去。
		while (
			this.#start < this.#buffer.length &&
			(this.buffered > this.capacity || this.#bytes > this.maxBytes)
		) {
			const oldest = this.#buffer[this.#start] as { seq: number; line: string };
			this.#bytes -= Buffer.byteLength(oldest.line);
			this.#evicted = oldest.seq;
			this.#buffer[this.#start] = undefined;
			this.#start++;
		}
		// 置空的槽位只占 8 字节：开头空出来的多到一定程度才真的挪一次数组。
		if (this.#start >= Math.max(this.capacity, 1024)) {
			this.#buffer.splice(0, this.#start);
			this.#start = 0;
		}
	}
}
