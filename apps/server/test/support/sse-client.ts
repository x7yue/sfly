import { expect } from "vitest";
import type { TestControlPlane } from "./test-control-plane.js";

/** 一条 SSE 消息；data 已按 JSON 解析。 */
export interface SseEvent<T = unknown> {
	event: string;
	data: T;
	id?: string;
}

/**
 * 测试用 SSE 客户端：对控制面的 SSE 路由发起真实的 HTTP 请求，按 text/event-stream 格式解析。
 * 用法与 FakeAgent 类似：`next(event)` 等待下一条未消费的某类消息，`expectNone(ms)` 断言一段时间内没有新消息。
 */
export class SseClient {
	readonly received: SseEvent[] = [];
	#consumed = 0;
	#waiters = new Set<() => void>();
	#ended = false;

	private constructor(
		private readonly abort: AbortController,
		body: ReadableStream<Uint8Array>,
	) {
		void this.#read(body);
	}

	/** 打开 SSE 流；断言响应为 200 + text/event-stream。 */
	static async open(cp: TestControlPlane, path: string): Promise<SseClient> {
		const abort = new AbortController();
		const res = await cp.fetch(path, {
			headers: { accept: "text/event-stream" },
			signal: abort.signal,
		});
		expect(res.status, `GET ${path}`).toBe(200);
		expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
		if (!res.body) throw new Error("SSE response has no body");
		return new SseClient(abort, res.body);
	}

	get ended(): boolean {
		return this.#ended;
	}

	/** 等待下一条未消费的 `event` 类型消息（跳过并消费掉中间其他类型的消息）。 */
	async next<T = unknown>(event: string, { timeoutMs = 3000 } = {}): Promise<SseEvent<T>> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			while (this.#consumed < this.received.length) {
				const msg = this.received[this.#consumed++] as SseEvent<T>;
				if (msg.event === event) return msg;
			}
			if (this.#ended) throw new Error(`SSE stream ended before "${event}"`);
			const left = deadline - Date.now();
			if (left <= 0) throw new Error(`timed out waiting for SSE event "${event}"`);
			await this.#wait(left);
		}
	}

	/** 断言 ms 毫秒内没有新消息。 */
	async expectNone(ms: number): Promise<void> {
		await new Promise((r) => setTimeout(r, ms));
		expect(this.received.slice(this.#consumed)).toEqual([]);
	}

	close(): void {
		this.abort.abort();
	}

	#wait(ms: number): Promise<void> {
		return new Promise((resolve) => {
			const done = () => {
				clearTimeout(timer);
				this.#waiters.delete(done);
				resolve();
			};
			const timer = setTimeout(done, ms);
			this.#waiters.add(done);
		});
	}

	#notify(): void {
		for (const waiter of [...this.#waiters]) waiter();
	}

	async #read(body: ReadableStream<Uint8Array>): Promise<void> {
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			for await (const chunk of body) {
				buffer += decoder.decode(chunk, { stream: true });
				for (;;) {
					const end = buffer.indexOf("\n\n");
					if (end < 0) break;
					const block = buffer.slice(0, end);
					buffer = buffer.slice(end + 2);
					const msg = parseBlock(block);
					if (msg) {
						this.received.push(msg);
						this.#notify();
					}
				}
			}
		} catch {
			// close() 中断读取。
		} finally {
			this.#ended = true;
			this.#notify();
		}
	}
}

function parseBlock(block: string): SseEvent | undefined {
	let event = "message";
	let id: string | undefined;
	const data: string[] = [];
	for (const line of block.split("\n")) {
		if (line === "" || line.startsWith(":")) continue;
		const colon = line.indexOf(":");
		const field = colon < 0 ? line : line.slice(0, colon);
		const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
		if (field === "event") event = value;
		else if (field === "data") data.push(value);
		else if (field === "id") id = value;
	}
	if (data.length === 0) return undefined;
	return { event, data: JSON.parse(data.join("\n")), ...(id === undefined ? {} : { id }) };
}
