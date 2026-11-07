// 不依赖 vitest 的 SSE 客户端（test/support/sse-client.ts 用 expect 断言，只能在测试里用）：
// 对控制面的 SSE 路由发起真实的 HTTP 请求，每收到一条消息就带着收到的时刻回调，用来测端到端延迟。
// 解析逻辑的单测见 test/perf-control-plane.test.ts。

/** 一条 SSE 消息；data 已按 JSON 解析。 */
export interface SseEvent {
	event: string;
	data: unknown;
	id?: string;
}

/** 增量解析 text/event-stream：push 一段文本，返回其中已经收齐（以空行结尾）的消息。 */
export class SseParser {
	#buffer = "";

	push(text: string): SseEvent[] {
		this.#buffer += text;
		const events: SseEvent[] = [];
		for (;;) {
			const end = this.#buffer.indexOf("\n\n");
			if (end < 0) return events;
			const event = parseBlock(this.#buffer.slice(0, end));
			this.#buffer = this.#buffer.slice(end + 2);
			if (event) events.push(event);
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

/** 一条打开的 SSE 流。 */
export interface SseStream {
	/** 读取结束（被 close() 中断或服务端关闭）时完成。 */
	readonly done: Promise<void>;
	close(): void;
}

/**
 * 打开一条 SSE 流（等到响应头），之后每收到一条消息就以「消息、收到时的 Date.now()」回调。
 * 一块数据里的多条消息共用同一个收到时刻。
 */
export async function openSse(
	url: string,
	onEvent: (event: SseEvent, receivedAtMs: number) => void,
): Promise<SseStream> {
	const abort = new AbortController();
	const res = await fetch(url, {
		headers: { accept: "text/event-stream" },
		signal: abort.signal,
	});
	if (res.status !== 200 || !res.body) {
		throw new Error(`GET ${url} 返回 ${res.status}：${await res.text()}`);
	}
	const body = res.body;
	const done = (async () => {
		const decoder = new TextDecoder();
		const parser = new SseParser();
		try {
			for await (const chunk of body) {
				const receivedAtMs = Date.now();
				for (const event of parser.push(decoder.decode(chunk, { stream: true }))) {
					onEvent(event, receivedAtMs);
				}
			}
		} catch {
			// close() 中断读取。
		}
	})();
	return { done, close: () => abort.abort() };
}
