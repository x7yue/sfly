import type {
	ErrorClass,
	NoticeKind,
	SessionEvent,
	SessionStatus,
	SessionTool,
	TurnLimit,
	TurnOutcome,
} from "@sfly/schema";

/**
 * 会话页的时间线（#542）：由一个纯函数从会话事件序列算出，页面只认平台的会话事件（`@sfly/schema` 的 `SessionEvent`），
 * 不认识 pi。状态是 {@link TimelineState}，输入是已有的状态和一条事件：{@link applyEvent}。
 *
 * - 持久的事件（有 `seq`）同一个序号来两次不重复：先读最近一页历史、再接事件流（从最大序号之后），两边可能有重叠；
 * - `assistant_delta` 追加到当前这条助手的话里，之后的 `assistant_message` 用整条的文字替换它（以它为准）；
 * - `tool_call` 之后同一个 `call_id` 的 `tool_result` 落在同一行；一轮结束时还没有结果的行不再算在做；
 * - `thinking` 只留一个「在思考」的标记，有文字或工具出来就去掉（思考的内容不显示）；一轮不在进行时（`turn_end` 之后、
 *   会话已结束）才到的 `thinking` 和 `assistant_delta` 是迟到的，不处理，「思考中」不会挂着；
 * - 用户的话按 `message_id` 去重，不靠文字；
 * - 这一版不渲染的类型（`turn_queued`、`tool_output`、`steer_queue`、`platform`、`snapshot`）和不认识的类型原样放过，不抛错。
 *   其中 `turn_started`、`session_ended` 只用来算会话的状态。
 */

export interface ToolResultInfo {
	isError: boolean;
	text: string;
	/** 结果太长，只留了头尾。 */
	truncated: boolean;
	/** 只有命令有；拿不到时没有。 */
	exitCode?: number;
	durationMs: number;
}

export type TimelineItem =
	| {
			kind: "user";
			key: string;
			seq: number;
			at: string;
			/** 这句话自己的 ID（控制面收到时分配）：去重和对应用它，不靠文字。 */
			messageId: string;
			author: string;
			text: string;
	  }
	| {
			kind: "assistant";
			key: string;
			/** 整条消息到了才有（逐字出现的时候没有）。 */
			seq: number | null;
			text: string;
			/** 还在逐字出现，整条消息还没到。 */
			streaming: boolean;
	  }
	| {
			kind: "tool";
			key: string;
			callId: string;
			/** 只有结果、没有对上的调用（调用在更早的一页里）时没有。 */
			tool: SessionTool | null;
			title: string;
			/** 调用开始的时间（事件产生的时间）；没有对上的调用时没有。 */
			at: string | null;
			result: ToolResultInfo | null;
			/** 这一轮已经有了结局、却一直没有结果（被停止、到了上限、中断）：不再算在做，写「已中止」。 */
			abandoned: boolean;
	  }
	| {
			kind: "notice";
			key: string;
			seq: number;
			noticeKind: NoticeKind;
			message: string;
	  }
	| {
			kind: "turn_end";
			key: string;
			seq: number;
			at: string;
			turn: number;
			outcome: TurnOutcome;
			reason: string;
			steps: number | undefined;
			modelCalls: number | undefined;
			durationMs: number;
			limitKind: TurnLimit | undefined;
			errorClass: ErrorClass | undefined;
	  };

export interface TimelineState {
	items: TimelineItem[];
	/** 会话此刻的状态：打开时取自会话视图，之后由 `turn_started`、`turn_end`、`session_ended` 推进。 */
	status: SessionStatus;
	/** 模型在思考，还没有文字或工具出来。 */
	thinking: boolean;
	/** 已处理的最大持久事件序号（0 表示还没有）：序号不大于它的持久事件不再处理。 */
	lastSeq: number;
	/** 已读到的最早的持久事件序号（往前翻页的 `before`）；一条也没有时为 null。 */
	oldestSeq: number | null;
	/** 更早的事件还有没有（会话接口的 `has_more`）。 */
	hasMore: boolean;
	/** 逐字出现的那一条助手的话的 key；没有时为 null。 */
	streamingKey: string | null;
	/** 逐字出现的助手的话的编号（给还没有序号的条目起 key）。 */
	streams: number;
}

export function emptyTimeline(status: SessionStatus): TimelineState {
	return {
		items: [],
		status,
		thinking: false,
		lastSeq: 0,
		oldestSeq: null,
		hasMore: false,
		streamingKey: null,
		streams: 0,
	};
}

/** 一条持久事件的序号；不持久的事件（文字增量、思考、工具输出……）没有。 */
const seqOf = (event: SessionEvent): number | undefined =>
	"seq" in event && typeof event.seq === "number" ? event.seq : undefined;

const toolKey = (callId: string) => `tool:${callId}`;

/** 替换某一条（按 key），其余不动。 */
const replaceItem = (
	items: TimelineItem[],
	key: string,
	update: (item: TimelineItem) => TimelineItem,
): TimelineItem[] => items.map((item) => (item.key === key ? update(item) : item));

/** 逐字出现的那一条定稿（不再逐字出现）；它的文字是空的就拿掉。 */
function finishStreaming(state: TimelineState): Pick<TimelineState, "items" | "streamingKey"> {
	const key = state.streamingKey;
	if (key === null) return { items: state.items, streamingKey: null };
	const items = state.items.flatMap((item): TimelineItem[] => {
		if (item.key !== key || item.kind !== "assistant") return [item];
		return item.text.trim() === "" ? [] : [{ ...item, streaming: false }];
	});
	return { items, streamingKey: null };
}

/**
 * 一条会话事件进来，算出新的状态。持久的事件（有 `seq`）序号不大于 `lastSeq` 时原样返回（同一条来第二次）；
 * 不认识的类型原样返回。
 */
export function applyEvent(state: TimelineState, event: SessionEvent): TimelineState {
	const seq = seqOf(event);
	if (seq !== undefined && seq <= state.lastSeq) return state;
	const next = apply(state, event);
	if (seq === undefined) return next;
	return {
		...next,
		lastSeq: seq,
		oldestSeq: next.oldestSeq === null ? seq : Math.min(next.oldestSeq, seq),
	};
}

/** 有一轮在进行：思考和文字增量只在这时有意义（它们不持久，一轮结束之后才到的是迟到的）。 */
const inTurn = (state: TimelineState): boolean =>
	state.status === "running" || state.status === "queued";

function apply(state: TimelineState, event: SessionEvent): TimelineState {
	switch (event.type) {
		case "user_message":
			// 同一句话（`message_id` 相同）不会有两个序号：补发和重叠时按它去重，连发两句相同的话仍是两句。
			if (state.items.some((item) => item.kind === "user" && item.messageId === event.message_id)) {
				return state;
			}
			return {
				...state,
				thinking: false,
				items: [
					...state.items,
					{
						kind: "user",
						key: `e${event.seq}`,
						seq: event.seq,
						at: event.at,
						messageId: event.message_id,
						author: event.author,
						text: event.text,
					},
				],
			};
		case "turn_started":
			return { ...state, status: "running" };
		case "thinking":
			// 一轮已经结束（或会话已结束）之后才到的思考（补发历史期间到达的、乱序的）不让「思考中」挂着。
			if (!inTurn(state)) return state;
			return state.thinking ? state : { ...state, thinking: true };
		case "assistant_delta": {
			if (!inTurn(state)) return state;
			if (state.streamingKey !== null) {
				const key = state.streamingKey;
				return {
					...state,
					thinking: false,
					items: replaceItem(state.items, key, (item) =>
						item.kind === "assistant" ? { ...item, text: item.text + event.text } : item,
					),
				};
			}
			const streams = state.streams + 1;
			const key = `stream:${streams}`;
			return {
				...state,
				thinking: false,
				streams,
				streamingKey: key,
				items: [
					...state.items,
					{ kind: "assistant", key, seq: null, text: event.text, streaming: true },
				],
			};
		}
		case "assistant_message": {
			// 整条消息以它为准：替换逐字拼出来的文字；没有逐字出现过（刷新后读历史）就直接是一条。
			const key = state.streamingKey;
			if (key !== null && state.items.some((item) => item.key === key)) {
				const items = state.items.flatMap((item): TimelineItem[] => {
					if (item.key !== key || item.kind !== "assistant") return [item];
					return event.text.trim() === ""
						? []
						: [{ ...item, seq: event.seq, text: event.text, streaming: false }];
				});
				return { ...state, thinking: false, items, streamingKey: null };
			}
			if (event.text.trim() === "") return { ...state, thinking: false, streamingKey: null };
			return {
				...state,
				thinking: false,
				streamingKey: null,
				items: [
					...state.items,
					{
						kind: "assistant",
						key: `e${event.seq}`,
						seq: event.seq,
						text: event.text,
						streaming: false,
					},
				],
			};
		}
		case "tool_call": {
			const key = toolKey(event.call_id);
			const settled = finishStreaming(state);
			const existing = settled.items.find((item) => item.key === key);
			if (existing?.kind === "tool") {
				// 先到了结果、调用后到（读历史时调用在更早的一页里被跳过又补上）：把调用的信息补到这一行。
				return {
					...state,
					...settled,
					thinking: false,
					items: replaceItem(settled.items, key, (item) =>
						item.kind === "tool"
							? { ...item, tool: event.tool, title: event.title, at: event.at }
							: item,
					),
				};
			}
			return {
				...state,
				...settled,
				thinking: false,
				items: [
					...settled.items,
					{
						kind: "tool",
						key,
						callId: event.call_id,
						tool: event.tool,
						title: event.title,
						at: event.at,
						result: null,
						// 一轮已经有了结局（或会话已结束）才到的调用：没有结果也不会再有，不转圈。
						abandoned: !inTurn(state),
					},
				],
			};
		}
		case "tool_result": {
			const key = toolKey(event.call_id);
			const result: ToolResultInfo = {
				isError: event.is_error,
				text: event.text,
				truncated: event.truncated,
				...(event.exit_code === undefined ? {} : { exitCode: event.exit_code }),
				durationMs: event.duration_ms,
			};
			if (state.items.some((item) => item.key === key)) {
				return {
					...state,
					items: replaceItem(state.items, key, (item) =>
						item.kind === "tool" ? { ...item, result, abandoned: false } : item,
					),
				};
			}
			// 没有对上的调用（它在更早的一页里）：先放一行只有结果的。
			return {
				...state,
				items: [
					...state.items,
					{
						kind: "tool",
						key,
						callId: event.call_id,
						tool: null,
						title: "",
						at: null,
						result,
						abandoned: false,
					},
				],
			};
		}
		case "notice":
			return {
				...state,
				items: [
					...state.items,
					{
						kind: "notice",
						key: `e${event.seq}`,
						seq: event.seq,
						noticeKind: event.kind,
						message: event.message,
					},
				],
			};
		case "turn_end": {
			// 同一轮只有一个结局（控制面只记第一条，后到的不记、不发布）：这一轮的结局已经画过，后来的（旧版本留下的、
			// 重复的）不再画一行；下一轮在做时，上一轮迟到的重复结局也不能把会话改回空闲。
			if (state.items.some((item) => item.kind === "turn_end" && item.turn === event.turn)) {
				return state;
			}
			const settled = finishStreaming(state);
			return {
				...state,
				...settled,
				thinking: false,
				// 会话已经结束就保持结束（`session_ended` 比这一轮的 `turn_end` 晚到的情况不存在，稳妥起见）。
				status: state.status === "ended" ? "ended" : "idle",
				items: [
					...settled.items.map(
						(item): TimelineItem =>
							item.kind === "tool" && item.result === null ? { ...item, abandoned: true } : item,
					),
					{
						kind: "turn_end",
						key: `e${event.seq}`,
						seq: event.seq,
						at: event.at,
						turn: event.turn,
						outcome: event.outcome,
						reason: event.reason,
						steps: event.steps,
						modelCalls: event.model_calls,
						durationMs: event.duration_ms,
						limitKind: event.limit_kind,
						errorClass: event.error_class,
					},
				],
			};
		}
		case "session_ended":
			return { ...state, status: "ended", thinking: false };
		default:
			// turn_queued、tool_output、steer_queue、platform、snapshot，以及以后才有的类型：这一版不渲染。
			return state;
	}
}

/**
 * 会话页打开时的状态：最近一页持久事件（序号升序），状态由这一页里最后一条状态性的事件推出来（`turn_started` 在做、
 * `turn_end` 空闲、`session_ended` 结束，见 `applyEvent`）；这一页里没有状态性的事件（没有事件，或一页全是工具行）时才用
 * 会话视图里的状态。事件流是从这一页最大的序号之后接的：页面显示的状态要和它收下的事件对得上，视图里的状态是另一次读取的，
 * 万一和事件不一致（读到「在做」之后这一轮结束了），不能让页面停在一个不会再有事件来改的状态上。`hasMore` 是接口的 `has_more`。
 */
export function initialTimeline(
	status: SessionStatus,
	events: readonly SessionEvent[],
	hasMore: boolean,
): TimelineState {
	const built = events.reduce(applyEvent, emptyTimeline(status));
	return { ...built, thinking: false, hasMore };
}

/**
 * 往前翻页：把更早的一页持久事件（序号升序）放到已有的前面。状态、逐字出现的话和 `lastSeq` 不变；
 * 只有结果、没有对上调用的行（调用在这一页里）和这一页里一直没有结果的调用行会接上。
 */
export function prependHistory(
	state: TimelineState,
	events: readonly SessionEvent[],
	hasMore: boolean,
): TimelineState {
	const older = events.reduce(applyEvent, emptyTimeline(state.status));
	// 这一页里没有结果的调用：结果在后面一页里（已经读进来了，是只有结果的那一行）就合上，否则不再算在做。
	const orphans = new Map(
		state.items.flatMap((item) =>
			item.kind === "tool" && item.tool === null && item.result
				? [[item.callId, item] as const]
				: [],
		),
	);
	const merged = older.items.map((item): TimelineItem => {
		if (item.kind !== "tool" || item.result !== null) return item;
		const orphan = orphans.get(item.callId);
		return orphan?.kind === "tool"
			? { ...item, result: orphan.result }
			: { ...item, abandoned: true };
	});
	const joined = new Set(
		merged.flatMap((item) => (item.kind === "tool" && item.result !== null ? [item.key] : [])),
	);
	const rest = state.items.filter(
		(item) => !(item.kind === "tool" && item.tool === null && joined.has(item.key)),
	);
	return {
		...state,
		items: [...merged, ...rest],
		oldestSeq:
			older.oldestSeq === null
				? state.oldestSeq
				: Math.min(older.oldestSeq, state.oldestSeq ?? older.oldestSeq),
		hasMore,
		streams: Math.max(state.streams, older.streams),
	};
}
