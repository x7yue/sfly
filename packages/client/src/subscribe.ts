import { ApiError } from "./errors.js";
import type { Exchange, ResponseLike } from "./exchange.js";
import { CONTROL_PLANE_TIME_EVENT } from "./generated/protocol.js";
import {
	type Handlers,
	type RouteInput,
	type RouteRef,
	requestPath,
	type SubscribeOptions,
	type Unsubscribe,
} from "./route.js";

const EVENT_STREAM = "text/event-stream";
const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 15_000;

/**
 * 一次订阅的状态：
 *
 *   connecting ──2xx 事件流──▶ open ──流结束或读取失败──▶ waiting ──间隔到了──▶ connecting
 *       ├──连不上、5xx──────────────────────────────────▶ waiting
 *       └──4xx、不是事件流──▶ closed（onError）        任何状态 ──关闭函数──▶ closed
 *
 * 重连间隔是流里 `retry:` 给的值（没有时 1 秒），连续失败时翻倍、最多 15 秒，连上后从头算。
 */
type State =
	| { readonly phase: "connecting" }
	| { readonly phase: "open"; readonly body: ReadableStream<Uint8Array> }
	| { readonly phase: "waiting" }
	| { readonly phase: "closed" };

const CONNECTING: State = { phase: "connecting" };
const WAITING: State = { phase: "waiting" };
const CLOSED: State = { phase: "closed" };

interface Message {
	event: string;
	data?: string;
	id?: string;
	retry?: number;
}

export function subscribe(
	exchange: Exchange,
	route: RouteRef & { readonly kind: "stream" },
	input: RouteInput | undefined,
	handlers: Handlers<Record<string, unknown>>,
	options: SubscribeOptions = {},
): Unsubscribe {
	const path = requestPath(route, input);
	const controller = new AbortController();
	const { signal } = controller;
	let lastEventId = "";
	let retryMs = FIRST_RETRY_MS;
	let failures = 0;

	const stop = (error: ApiError): State => {
		controller.abort();
		report(() => options.onError?.(error));
		return CLOSED;
	};

	const receive = (message: Message) => {
		if (signal.aborted) return;
		if (message.id !== undefined) lastEventId = message.id;
		if (message.retry !== undefined) retryMs = message.retry;
		if (message.data === undefined) return;
		let data: unknown;
		try {
			data = JSON.parse(message.data);
		} catch {
			return;
		}
		if (message.event === CONTROL_PLANE_TIME_EVENT) {
			exchange.noteTime((data as { time?: unknown } | null)?.time);
			return;
		}
		const handler = handlers[message.event];
		if (handler) report(() => handler(data));
	};

	const step = async (state: State): Promise<State> => {
		if (signal.aborted) return CLOSED;
		switch (state.phase) {
			case "connecting": {
				let res: ResponseLike;
				try {
					res = await exchange.send(route, input, {
						accept: EVENT_STREAM,
						signal,
						headers: lastEventId === "" ? {} : { "last-event-id": lastEventId },
					});
				} catch (error) {
					if (signal.aborted) return CLOSED;
					if (!(error instanceof ApiError)) throw error;
					return error.status === 0 || error.status >= 500 ? WAITING : stop(error);
				}
				if (!res.body || !res.headers.get("content-type")?.startsWith(EVENT_STREAM)) {
					return stop(
						new ApiError({
							status: res.status,
							code: "invalid_response",
							message: "响应不是事件流",
							method: route.method,
							path,
						}),
					);
				}
				failures = 0;
				report(() => options.onOpen?.());
				return { phase: "open", body: res.body };
			}
			case "open":
				await readMessages(state.body, receive).catch(() => {});
				return WAITING;
			case "waiting":
				await delay(Math.min(retryMs * 2 ** failures++, MAX_RETRY_MS), signal);
				return CONNECTING;
			case "closed":
				return state;
		}
	};

	void (async () => {
		let state = CONNECTING;
		while (state.phase !== "closed") state = await step(state);
	})();
	return () => controller.abort();
}

/** 调用方的回调抛出的错误不影响订阅，像事件监听器一样另行报告。 */
function report(callback: () => void): void {
	try {
		callback();
	} catch (error) {
		queueMicrotask(() => {
			throw error;
		});
	}
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener("abort", done);
	});
}

/** 按 text/event-stream 的格式（WHATWG HTML 9.2）逐条读出消息，空行结束一条。 */
async function readMessages(
	body: ReadableStream<Uint8Array>,
	receive: (message: Message) => void,
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let rest = "";
	let message: Message = { event: "message" };
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return;
		const lines = (rest + decoder.decode(value, { stream: true })).split(/\r\n|\r|\n/);
		rest = lines.pop() ?? "";
		for (const line of lines) {
			if (line === "") {
				receive(message);
				message = { event: "message" };
				continue;
			}
			const colon = line.indexOf(":");
			if (colon === 0) continue;
			const field = colon < 0 ? line : line.slice(0, colon);
			const value = colon < 0 ? "" : line.slice(line[colon + 1] === " " ? colon + 2 : colon + 1);
			if (field === "event") message.event = value;
			else if (field === "data") {
				message.data = message.data === undefined ? value : `${message.data}\n${value}`;
			} else if (field === "id" && !value.includes("\0")) message.id = value;
			else if (field === "retry" && /^\d+$/.test(value)) message.retry = Number(value);
		}
	}
}
