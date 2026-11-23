import { randomUUID } from "node:crypto";
import type { Page, Route } from "@playwright/test";
import type { Readiness, SessionEvent } from "@sfly/schema";

// 助手页和会话页的端到端测试共用（#542）：控制面是真的（会话、事件读出来的是库里的），会话的写接口和助手服务
// 在 #541 的第二个 PR 之前还没有，所以写接口用 `page.route` 拦截；会话的实时事件用 `installSessionStream` 在页面里
// 接管事件流（测试一条一条推，页面一条一条收），不依赖时间。

export const USAGE = { input: 1200, output: 80, cache_read: 900, cache_write: 0 };

/** 助手可以用、工作台在线。 */
export const READY: Readiness = { ready: true, problems: [], workbench: "bench-1" };

const json = (route: Route, status: number, body: unknown) =>
	route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** 接口的错误响应（`ApiErrorBody`）。 */
export const apiError = (route: Route, status: number, code: string, message: string) =>
	json(route, status, { error: { code, message } });

/** 拦截项目的会话列表（`GET /api/projects/default/sessions`）：就绪状态和会话由测试给。 */
export async function stubSessionList(
	page: Page,
	readiness: Readiness,
	sessions: unknown[] = [],
	create?: (route: Route, body: { text: string }) => Promise<void> | void,
	truncated = false,
) {
	await page.route("**/api/projects/*/sessions", async (route) => {
		const request = route.request();
		if (request.method() === "POST" && create) {
			await create(route, request.postDataJSON() as { text: string });
			return;
		}
		await json(route, 200, { readiness, sessions, truncated });
	});
}

/** 一个会话视图（`SessionView`）。 */
export function sessionView(over: Record<string, unknown> = {}) {
	return {
		id: randomUUID(),
		title: "给 http_check 加超时",
		status: "idle",
		created_by: "alice",
		created_at: "2026-01-01T00:00:00.000Z",
		last_activity_at: "2026-01-01T00:00:05.000Z",
		queue_position: null,
		last_turn_outcome: null,
		project: "default",
		readiness: READY,
		waiting_for: null,
		...over,
	};
}

let tick = 0;
/** 持久事件的时间：从手动时钟的起点起，每条晚一秒。 */
export const eventAt = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++ % 50)).toISOString();

type Persisted<T extends SessionEvent["type"]> = Extract<SessionEvent, { type: T }>;

export const userMessage = (
	seq: number,
	text = "给 http_check 加超时",
): Persisted<"user_message"> => ({
	type: "user_message",
	seq,
	at: eventAt(),
	message_id: randomUUID(),
	text,
	steer: false,
	author: "alice",
	author_user_id: null,
});
export const turnStarted = (seq: number): Persisted<"turn_started"> => ({
	type: "turn_started",
	seq,
	at: eventAt(),
	turn: 1,
});
export const assistantMessage = (seq: number, text: string): Persisted<"assistant_message"> => ({
	type: "assistant_message",
	seq,
	at: eventAt(),
	text,
	usage: USAGE,
});
export const toolCall = (
	seq: number,
	callId: string,
	tool: "command" | "edit" | "read" | "write",
	title: string,
	at = eventAt(),
): Persisted<"tool_call"> => ({ type: "tool_call", seq, at, call_id: callId, tool, title });
export const toolResult = (
	seq: number,
	callId: string,
	extra: Partial<Persisted<"tool_result">> = {},
): Persisted<"tool_result"> => ({
	type: "tool_result",
	seq,
	at: eventAt(),
	call_id: callId,
	is_error: false,
	text: "ok\n",
	truncated: false,
	duration_ms: 420,
	...extra,
});
export const turnEnd = (
	seq: number,
	outcome: Persisted<"turn_end">["outcome"],
	extra: Partial<Persisted<"turn_end">> = {},
): Persisted<"turn_end"> => ({
	type: "turn_end",
	seq,
	at: eventAt(),
	turn: 1,
	outcome,
	reason: "",
	duration_ms: 84_000,
	...extra,
});

/**
 * 接管会话的事件流（`GET /api/sessions/:id/events`）：页面里的 `fetch` 对这个地址返回一个由测试控制的流，
 * `pushEvent` 推一条（持久的带序号作事件 ID，不持久的不带）。要在页面打开之前调用。
 */
export async function installSessionStream(page: Page) {
	await page.addInitScript(() => {
		const original = window.fetch.bind(window);
		const encoder = new TextEncoder();
		const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
		const sse = {
			opened: 0,
			urls: [] as string[],
			push(event: string, data: unknown, id?: number) {
				const head = id === undefined ? "" : `id: ${id}\n`;
				const text = `${head}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
				for (const controller of controllers) controller.enqueue(encoder.encode(text));
			},
		};
		Object.assign(window, { __sessionStream: sse });
		window.fetch = (input, init) => {
			const url =
				typeof input === "string" ? input : input instanceof Request ? input.url : `${input}`;
			if (!/\/api\/sessions\/[^/?]+\/events/.test(url)) return original(input, init);
			sse.opened++;
			sse.urls.push(url);
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controllers.push(controller);
					init?.signal?.addEventListener("abort", () => {
						try {
							controller.close();
						} catch {
							// 已经关了
						}
					});
				},
			});
			return Promise.resolve(
				new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
			);
		};
	});
}

/** 往接管的事件流里推一条事件。 */
export function pushEvent(page: Page, event: SessionEvent) {
	const id = "seq" in event ? event.seq : undefined;
	return page.evaluate(
		([name, data, eventId]) => {
			(
				window as unknown as {
					__sessionStream: { push(e: string, d: unknown, id?: number): void };
				}
			).__sessionStream.push(name as string, data, eventId as number | undefined);
		},
		[event.type, event, id] as const,
	);
}

/** 接管的事件流打开了几次、每次的地址。 */
export const streamOpens = (page: Page) =>
	page.evaluate(
		() =>
			(window as unknown as { __sessionStream: { opened: number; urls: string[] } })
				.__sessionStream,
	);

/**
 * 拦截会话的历史（`GET /api/sessions/:id`）：返回 `persisted` 里当前所有的持久事件，像控制面那样（刷新页面后读回
 * 刚才推过的持久事件）。`persisted` 由测试往里加。
 */
export async function stubSessionDetail(
	page: Page,
	view: ReturnType<typeof sessionView>,
	persisted: SessionEvent[],
) {
	await page.route(new RegExp(`/api/sessions/${view.id}(\\?.*)?$`), (route) => {
		if (route.request().method() !== "GET") return route.fallback();
		return json(route, 200, { ...view, events: persisted, has_more: false });
	});
}

export { json as fulfillJson };
