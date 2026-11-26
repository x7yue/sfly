import { randomBytes } from "node:crypto";
import {
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
 * （已经序列化好的行；序号是整个助手服务共用的，不分会话），不持久的不留。没有连接时产生的持久事件也进缓冲，控制面连上后补发。
 */
export class EventBus {
	readonly epoch = randomBytes(9).toString("base64url");
	#seq = 0;
	readonly #subscribers = new Set<(line: string) => void>();
	/** 最近的持久事件，序号升序、连续。开头削掉的用 `#start` 记着（隔一阵才真的挪一次数组，不在每条事件上都复制）。 */
	readonly #buffer: Array<{ seq: number; line: string }> = [];
	#start = 0;

	constructor(
		private readonly now: () => Date = () => new Date(),
		private readonly capacity: number = ASSISTANT_REPLAY_BUFFER_EVENTS,
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
	 * 控制面带着 `after` 连上来：要不要补发、补发哪些、`hello.gap` 是什么（规则见协议的 `AssistantEventsQuery`）。
	 * **和订阅实时的事件在同一步里做**（调用方在同一个同步段里调用它和 {@link EventBus.subscribe}）：补发的最后一条和订阅之后的
	 * 第一条实时事件之间不漏、不重。
	 */
	resume(after: StreamPosition | undefined): Resumption {
		if (after === undefined) return { gap: false, lines: [] };
		if (after.epoch !== this.epoch || after.seq > this.#seq) return { gap: true, lines: [] };
		const first = this.#buffer[this.#start];
		// 缓冲里最早的一条比 `after` 之后的第一条还晚：中间的被挤出去了。缓冲是空的（还没有过持久的事件）时 `after.seq` 只能是 0。
		if (first !== undefined && first.seq > after.seq + 1) return { gap: true, lines: [] };
		const lines: string[] = [];
		for (let index = this.#start; index < this.#buffer.length; index++) {
			const entry = this.#buffer[index] as { seq: number; line: string };
			if (entry.seq > after.seq) lines.push(entry.line);
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
		if (this.#buffer.length - this.#start > this.capacity) this.#start++;
		// 开头削掉的多到和留着的一样多时才真的挪一次。
		if (this.#start >= Math.max(this.capacity, 1024)) {
			this.#buffer.splice(0, this.#start);
			this.#start = 0;
		}
	}
}
