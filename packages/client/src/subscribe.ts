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
 * 连上之后连着这么久（毫秒）一个字节也没收到，就当作连接已经死了、自己断开重连：控制面每 15 秒在每条事件流里写一条心跳
 * （`SseOptions.heartbeatMs`），三次没到就是没了。读流的 `reader.read()` 没有超时：中间的设备悄悄丢了这条连接（休眠醒来、网络切换、
 * NAT 表项过期，没有 FIN 也没有 RST）时没有任何事件通知它，不设这一道就永远等下去，页面再也收不到之后的事件。
 */
const DEFAULT_STALL_MS = 45_000;

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
	const stallMs = options.stallMs ?? DEFAULT_STALL_MS;

	const stop = (error: ApiError): State => {
		controller.abort();
		callIsolated(() => options.onError?.(error));
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
			callIsolated(() => exchange.noteTime((data as { time?: unknown } | null)?.time));
			return;
		}
		const handler = handlers[message.event];
		if (handler) callIsolated(() => handler(data));
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
					if (!(error instanceof ApiError)) {
						controller.abort();
						throw error;
					}
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
				callIsolated(() => options.onOpen?.());
				return { phase: "open", body: res.body };
			}
			case "open":
				await readMessages(state.body, receive, stallMs).catch(() => {});
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

function callIsolated(callback: () => void): void {
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

/**
 * https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation
 *
 * `stallMs` 内一个字节也没收到（心跳也没有）就取消读取：正在等的 `read()` 以「读完了」返回，调用方当作连接断了去重连。
 */
async function readMessages(
	body: ReadableStream<Uint8Array>,
	receive: (message: Message) => void,
	stallMs: number,
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let rest = "";
	let message: Message = { event: "message" };
	let stalled: ReturnType<typeof setTimeout> | undefined;
	const watch = () => {
		clearTimeout(stalled);
		stalled = setTimeout(() => void reader.cancel().catch(() => {}), stallMs);
	};
	watch();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			watch();
			const text = rest + decoder.decode(value, { stream: !done });
			const heldCr = !done && text.endsWith("\r") ? "\r" : "";
			const lines = text.slice(0, text.length - heldCr.length).split(/\r\n|\r|\n/);
			rest = (lines.pop() ?? "") + heldCr;
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
			if (done) return;
		}
	} finally {
		clearTimeout(stalled);
	}
}
