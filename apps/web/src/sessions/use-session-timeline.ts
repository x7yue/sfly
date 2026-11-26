import {
	SESSION_EVENT_TYPES,
	type SessionDetailResponse,
	type SessionEvent,
	sessionsApi,
} from "@sfly/schema";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ApiError, callApi } from "#/lib/api";
import { openEventSource } from "#/lib/sse";
import { addResult, addResults, emptyResults, type SessionResults } from "./results";
import { queueOf } from "./session-text";
import {
	applyEvent,
	applyQueuedView,
	initialTimeline,
	prependHistory,
	type TimelineQueue,
	type TimelineState,
} from "./timeline";

export type SessionAction =
	| { type: "event"; event: SessionEvent }
	| { type: "older"; events: readonly SessionEvent[]; hasMore: boolean }
	| { type: "queued"; queue: TimelineQueue; after: number };

/**
 * 页面上的状态：时间线，和右侧「成果」（`results.ts`）。两个都由同一批事件算出来（读到的历史、事件流、往前翻页），
 * 成果不另开连接，也不再读一遍历史。
 */
export interface SessionState {
	timeline: TimelineState;
	results: SessionResults;
}

/** 打开页面时的状态：读到的最近一页事件（历史）。 */
export function initialSession(d: SessionDetailResponse): SessionState {
	return {
		timeline: initialTimeline(
			d.status,
			d.events,
			d.has_more,
			queueOf(d.queue_position, d.waiting_for),
		),
		results: addResults(emptyResults, d.events),
	};
}

/** 三条路读到的事件都进同一个状态：事件流推来的（`event`）、往前翻页读到的（`older`），和打开页面时的历史（{@link initialSession}）。 */
export function reduceSession(state: SessionState, action: SessionAction): SessionState {
	switch (action.type) {
		case "event":
			return {
				timeline: applyEvent(state.timeline, action.event),
				results: addResult(state.results, action.event),
			};
		case "older":
			return {
				timeline: prependHistory(state.timeline, action.events, action.hasMore),
				results: addResults(state.results, action.events),
			};
		case "queued":
			return {
				...state,
				timeline: applyQueuedView(state.timeline, action.queue, action.after),
			};
	}
}

/** 时间线上有对应渲染的事件类型；其余在开发环境下在控制台记一条（由引入它们的任务加渲染）。 */
const RENDERED: ReadonlySet<string> = new Set([
	"user_message",
	"turn_started",
	"thinking",
	"assistant_delta",
	"assistant_message",
	"tool_call",
	"tool_output",
	"tool_result",
	"notice",
	"turn_end",
	"session_ended",
	"turn_queued",
	"steer_queue",
	"platform",
	"snapshot",
]);

/**
 * 会话页的时间线状态：先用 `GET /sessions/:id` 取到的最近一页事件算出来（状态、排位和在等谁取自会话视图），再接
 * `GET /sessions/:id/events`（从已有的最大序号之后），每条事件交给纯函数 `applyEvent`；往前翻页用 `before`。断线后事件流自动重连，
 * 重连带上最后收到的事件序号，补发断线期间的持久事件；重叠的事件按序号去重。事件流不再重连（控制面回了 404：会话被删了，新建会话
 * 等第一轮结局期间点了停止，没有被碰过的会话会被删掉）时 `gone` 为真，页面回到列表。
 */
export function useSessionTimeline(detail: SessionDetailResponse) {
	const id = detail.id;
	const [{ timeline: state, results }, dispatch] = useReducer(
		reduceSession,
		detail,
		initialSession,
	);
	const [gone, setGone] = useState(false);
	// 事件流从读到的历史之后开始：先读历史再接流，两边的重叠由序号去重。
	const [after] = useState(() => state.lastSeq);
	useEffect(() => {
		const handlers = Object.fromEntries(
			SESSION_EVENT_TYPES.map((type) => [
				type,
				(data: unknown) => {
					if (import.meta.env.DEV && !RENDERED.has(type)) {
						console.info(`会话事件「${type}」这一版不渲染`);
					}
					dispatch({ type: "event", event: data as SessionEvent });
				},
			]),
		);
		return openEventSource(
			sessionsApi.events,
			{ params: { id }, query: { after } },
			handlers as Parameters<typeof openEventSource<typeof sessionsApi.events>>[2],
			undefined,
			(error) => {
				if (error instanceof ApiError && error.status === 404) setGone(true);
			},
		);
	}, [id, after]);

	const [loadingOlder, setLoadingOlder] = useState(false);
	const [olderError, setOlderError] = useState<Error | null>(null);
	const oldest = useRef(state.oldestSeq);
	oldest.current = state.oldestSeq;
	const loadOlder = useCallback(async () => {
		const before = oldest.current;
		if (before === null) return;
		setLoadingOlder(true);
		setOlderError(null);
		try {
			const page = await callApi(sessionsApi.get, { params: { id }, query: { before } });
			dispatch({ type: "older", events: page.events, hasMore: page.has_more });
		} catch (error) {
			setOlderError(error instanceof Error ? error : new Error(String(error)));
		} finally {
			setLoadingOlder(false);
		}
	}, [id]);

	/**
	 * 空闲的会话说完话之后核对一次状态：这句话排上了队（项目里别的会话在等开始，没有会话在做）时控制面不推 `turn_queued`
	 * （没有「在等谁」可写），页面从会话视图里得知排位。取的是 `before: 1`（比第 1 条还早的事件：没有），只要视图。读不到就算了：
	 * 只是核对一次，事件流照常推进。
	 */
	const syncQueue = useCallback(
		async (after: number) => {
			try {
				const view = await callApi(sessionsApi.get, { params: { id }, query: { before: 1 } });
				const queue = queueOf(view.queue_position, view.waiting_for);
				if (view.status === "queued" && queue !== null) dispatch({ type: "queued", queue, after });
			} catch {
				// 事件流照常推进。
			}
		},
		[id],
	);

	return { state, results, loadOlder, loadingOlder, olderError, gone, syncQueue };
}
