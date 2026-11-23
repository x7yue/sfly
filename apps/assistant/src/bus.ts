import { randomBytes } from "node:crypto";
import {
	type AssistantEvent,
	type AssistantStreamHello,
	type AssistantStreamRecord,
	PERSISTED_SESSION_EVENT_TYPES,
} from "@sfly/schema";

/**
 * 事件流（`GET /events`）：纪元（每次启动生成）、纪元内递增的序号（只给持久的事件），把事件推给连着的每一条流。
 * `at` 是事件产生的时间（助手服务的时钟），控制面原样存。没有连接时产生的事件丢掉：缓冲和续传是 #545。
 */
export class EventBus {
	readonly epoch = randomBytes(9).toString("base64url");
	#seq = 0;
	readonly #subscribers = new Set<(line: string) => void>();

	constructor(private readonly now: () => Date = () => new Date()) {}

	hello(): AssistantStreamHello {
		return { type: "hello", epoch: this.epoch, gap: false };
	}

	subscribe(write: (line: string) => void): () => void {
		this.#subscribers.add(write);
		return () => this.#subscribers.delete(write);
	}

	get subscribers(): number {
		return this.#subscribers.size;
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
		for (const write of this.#subscribers) write(line);
		return record;
	}
}
