import type {
	CommitFile,
	ErrorClass,
	NoticeKind,
	SessionEvent,
	SessionStatus,
	SessionTool,
	TurnLimit,
	TurnOutcome,
	WaitingFor,
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
 * - 用户的话按 `message_id` 去重，不靠文字；用户的话分三种（{@link UserRole}）：开一轮的话；**插话**（`steer` 为 true，在做时说的）；
 *   **排在这一轮后面的话**（`steer` 为 false、却是在一轮进行中说的：控制面发出中止之后、结局写下之前说的话，协议「停止一轮」，
 *   是新的一轮的开头，不是插话），这一轮的结局写下之后会话是排队中，轮到它时 `turn_started` 把它变成开一轮的话；停止按钮这时写「撤掉排着的话」，点它、
 *   会话被停止时它被撤掉（`queue_cancelled`）；
 * - **插话送到了没有**（{@link SteerDelivery}）：`steer_queue` 是还没送到的完整列表，在最近一份里是「等待送达」，之前在某份里、
 *   之后不在了是「已送到」；`steer_dropped` 通知带着这句话的 `message_id`，按它对上，是「没有送到」（同一句话的通知只显示一次）；
 *   一轮结束时还没有 `steer_dropped` 的都算送到（协议「不变式」）；刷新后读到的历史里没有 `steer_queue`（不持久），在做的一轮里的插话在
 *   下一份 `steer_queue` 到之前不知道，**也不因为后来的一份列表里没有它就算送到**（它可能还没到助手服务手上）：在一份列表里见到它才变成
 *   等待送达，这一轮结束时照 `steer_dropped` 的有无定；往前翻页不动在做的一轮里已经有的插话；
 * - **补发的次序**（#544 评论 8）：补发（打开页面、重连）期间到的不持久的事件在补发完之后才放出来，会排在比它晚的持久事件后面。
 *   所以 `steer_queue` 只在一轮在做时才算，`turn_queued` 只在排队时才算，别的时候是晚到的、按「这一轮已经过去」丢掉；「已送到」只由
 *   「之前出现过、现在不在了」推出来，不因为一句话不在列表里就算送到；
 * - `turn_queued`（排第几、在等谁）记在 {@link TimelineState.queue}；`session_ended` 一行写会话已结束；
 * - `platform`（`commit`）是平台在一轮结束时提交工作区的记录（#546）：一行「这一轮改了 N 个文件 +a −b」，展开是文件列表和差异（{@link CommitItem}）；
 *   被打断那一轮留下的改动在下一轮开始前补提交，事件的 `turn` 比它所在的这一轮小（`leftover`）；
 * - 这一版不渲染的类型（`tool_output`、`platform` 的 `scenario_version`、`run`、`snapshot`）和不认识的类型原样放过，不抛错。
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
			role: UserRole;
			/** 插话（`role` 为 `steer`）送到了没有；别的话是 null。 */
			delivery: SteerDelivery | null;
			/** `delivery` 为 `dropped` 时，`steer_dropped` 通知给的那句说明（里面写着是没有送到还是没有确认送到）。 */
			droppedNote: string | null;
			/** 在某一份 `steer_queue` 里出现过（推出「已送到」用，不显示）。 */
			queuedSeen: boolean;
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
			/** `steer_dropped`、`queue_cancelled` 带的那句话的 ID；别的提示是 null。 */
			messageId: string | null;
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
	  }
	| CommitItem
	| {
			kind: "session_ended";
			key: string;
			seq: number;
			at: string;
			/** 结束它的人的昵称。 */
			by: string;
	  };

/** 平台在一轮结束时提交工作区的记录（`platform` 事件的 `commit`）：提交那一刻的文件统计和差异，事后改写 git 历史也改不了。 */
export interface CommitItem {
	kind: "commit";
	key: string;
	seq: number;
	at: string;
	/** 这个提交属于第几轮。 */
	turn: number;
	/**
	 * 上一轮（被打断的）留下的改动，在这一轮开始前补提交的：它的 `turn` 比这一轮小。不知道这一轮是第几轮时（`turn_started` 在更早的
	 * 一页里）按这一轮自己的提交算。
	 */
	leftover: boolean;
	hash: string;
	files: CommitFile[];
	diff: string;
	/** 差异太长，只存了开头。 */
	truncated: boolean;
}

/**
 * 用户的一句话是什么：`turn` 开一轮的话；`steer` 插话（在做时说的）；`behind` 排在这一轮后面的话（停止途中说的，这一轮的结局写下之后
 * 开始它）；`cancelled` 排着的话被撤掉了（`queue_cancelled`）。
 */
export type UserRole = "turn" | "steer" | "behind" | "cancelled";

/** 插话送到了没有：`waiting` 等待送达，`delivered` 已送到，`dropped` 没有送到，`unknown` 不知道（刷新后读到在做的一轮里的插话）。 */
export type SteerDelivery = "waiting" | "delivered" | "dropped" | "unknown";

/** 排队的会话排第几、在等谁（`turn_queued`，或打开页面时会话视图里的）。 */
export interface TimelineQueue {
	position: number;
	waitingFor: WaitingFor | null;
}

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
	/** 有一轮在进行（`turn_started` 之后、`turn_end` 之前，按事件算）：这时说的不是插话的话，是排在这一轮后面的话。 */
	turnOpen: boolean;
	/**
	 * 有一句开一轮的话还没有等到它的 `turn_started`（会话空闲时说的话，项目里别的会话在做就排队）：只有这时一条 `turn_queued` 才让会话
	 * 变成排队中；补发完才放出来的、属于已经开始过的那一轮的 `turn_queued` 不算（它之后已经有了 `turn_started`）。
	 */
	awaitingStart: boolean;
	/** 最近一份 `steer_queue` 里的 `message_id`（还没送到的插话）；一轮开始、结束时清空。 */
	steerQueue: readonly string[];
	/** 排队中的位置和在等谁；不在排队时为 null。 */
	queue: TimelineQueue | null;
	/** 最近一个 `turn_started` 的轮次（还没有见到时为 0）：补提交（`leftover`）靠它认。 */
	currentTurn: number;
}

export function emptyTimeline(
	status: SessionStatus,
	queue: TimelineQueue | null = null,
	turnOpen = false,
): TimelineState {
	return {
		items: [],
		status,
		thinking: false,
		lastSeq: 0,
		oldestSeq: null,
		hasMore: false,
		streamingKey: null,
		streams: 0,
		turnOpen,
		awaitingStart: status === "queued",
		steerQueue: [],
		queue,
		currentTurn: 0,
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

/**
 * 读到的这一段事件开头，有没有一轮已经在进行（它的 `turn_started` 在更早的一页里）：这一段里先出现的是 `turn_end`，就是有；先出现的是
 * `turn_started`，或者两个都没有，就没有。用来分清这一段开头的话是开一轮的话，还是排在这一轮后面的话。两个都没有（整段都在同一轮里、
 * `turn_started` 在更早的一页）时分不出来，那时「有话排在这一轮后面」由会话视图的排位说了算（{@link initialTimeline}）。
 */
function startsInTurn(events: readonly SessionEvent[]): boolean {
	for (const event of events) {
		if (event.type === "turn_end") return true;
		if (event.type === "turn_started") return false;
	}
	return false;
}

/** 最后一句开一轮的话（不是插话）改成排在这一轮后面的话。 */
function markLastTurnWordsBehind(items: readonly TimelineItem[]): TimelineItem[] {
	let last = -1;
	items.forEach((item, index) => {
		if (item.kind === "user" && item.role === "turn") last = index;
	});
	return items.map((item, index) =>
		index === last && item.kind === "user" ? { ...item, role: "behind" } : item,
	);
}

/** 有话排在这一轮后面（停止途中说的，还没有开始）。 */
export const hasBehind = (items: readonly TimelineItem[]): boolean =>
	items.some((item) => item.kind === "user" && item.role === "behind");

/**
 * 由读到的一段历史（持久事件）重新判断插话的送达：有 `steer_dropped` 的是没有送到；它之后这一轮已经有了结局的（没有 `steer_dropped`）是
 * 送到了；其余（读到在做的一轮里的插话）在下一份 `steer_queue` 到之前不知道。读历史（打开、往前翻页）之后调用，每条事件落在哪一页都一样。
 * `upTo` 之后的不动：往前翻页只重判新读进来的那一段，在做的一轮里已经有的插话（等待送达、不知道）保持原样。
 */
function resolveSteers(items: readonly TimelineItem[], upTo = items.length): TimelineItem[] {
	const dropped = new Map<string, string>();
	for (const item of items) {
		if (item.kind === "notice" && item.noticeKind === "steer_dropped" && item.messageId !== null) {
			if (!dropped.has(item.messageId)) dropped.set(item.messageId, item.message);
		}
	}
	let lastEnd = -1;
	items.forEach((item, index) => {
		if (item.kind === "turn_end") lastEnd = index;
	});
	return items.map((item, index): TimelineItem => {
		// `upTo` 之后的不动（往前翻页只重判新读进来的那一段，在做的一轮里已经有的插话保持原样）。
		if (index >= upTo || item.kind !== "user" || item.role !== "steer") return item;
		const note = dropped.get(item.messageId);
		if (note !== undefined)
			return { ...item, delivery: "dropped", droppedNote: item.droppedNote ?? note };
		if (item.delivery === "dropped" || item.delivery === "delivered") return item;
		return { ...item, delivery: index < lastEnd ? "delivered" : "unknown" };
	});
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
				awaitingStart: state.awaitingStart || (!event.steer && !state.turnOpen),
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
						// 在做时说的：`steer` 为 true 是插话；为 false、却有一轮在进行的是排在这一轮后面的话（停止途中说的）。
						role: event.steer ? "steer" : state.turnOpen ? "behind" : "turn",
						delivery: event.steer ? "waiting" : null,
						droppedNote: null,
						// 这句话的 `steer_queue` 比它的 `user_message` 先到（补发的次序）：已经在队列里了。
						queuedSeen: event.steer && state.steerQueue.includes(event.message_id),
					},
				],
			};
		case "turn_started":
			// 排在后面的话轮到了：它就是这一轮的开头。
			return {
				...state,
				status: "running",
				turnOpen: true,
				currentTurn: event.turn,
				awaitingStart: false,
				steerQueue: [],
				queue: null,
				items: state.items.map(
					(item): TimelineItem =>
						item.kind === "user" && item.role === "behind" ? { ...item, role: "turn" } : item,
				),
			};
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
		case "notice": {
			const messageId = event.message_id ?? null;
			// 按 `message_id` 对上那句话：`steer_dropped` 是插话没有送到，`queue_cancelled` 是排着的话被撤掉了。
			let items = state.items;
			if (messageId !== null && event.kind === "steer_dropped") {
				items = items.map(
					(item): TimelineItem =>
						item.kind === "user" && item.role === "steer" && item.messageId === messageId
							? { ...item, delivery: "dropped", droppedNote: item.droppedNote ?? event.message }
							: item,
				);
			}
			let status: SessionStatus = state.status;
			let queue = state.queue;
			if (messageId !== null && event.kind === "queue_cancelled") {
				items = items.map(
					(item): TimelineItem =>
						item.kind === "user" &&
						(item.role === "behind" || item.role === "turn") &&
						item.messageId === messageId
							? { ...item, role: "cancelled" }
							: item,
				);
				// 排队的会话被停止：回到空闲；排在这一轮后面的话被撤掉：不再有排位。
				if (status === "queued") status = "idle";
				if (!hasBehind(items)) queue = null;
			}
			const cancelledAwait = event.kind === "queue_cancelled" && !hasBehind(items);
			// 同一句话的同一种提示只显示一次（`steer_dropped` 可能有两条：控制面写了「没有确认送到」，助手服务之后又确认没送到）。
			const shown =
				messageId !== null &&
				state.items.some(
					(item) =>
						item.kind === "notice" &&
						item.noticeKind === event.kind &&
						item.messageId === messageId,
				);
			return {
				...state,
				status,
				queue,
				awaitingStart: cancelledAwait ? false : state.awaitingStart,
				items: shown
					? items
					: [
							...items,
							{
								kind: "notice",
								key: `e${event.seq}`,
								seq: event.seq,
								noticeKind: event.kind,
								message: event.message,
								messageId,
							},
						],
			};
		}
		case "steer_queue": {
			// 这一轮不在做：晚到的（补发完才放出来的、属于已经过去的一轮的队列），不算。
			if (state.status !== "running") return state;
			const listed = new Set(event.messages.map((entry) => entry.message_id));
			return {
				...state,
				steerQueue: [...listed],
				items: state.items.map((item): TimelineItem => {
					if (item.kind !== "user" || item.role !== "steer") return item;
					if (item.delivery === "delivered" || item.delivery === "dropped") return item;
					if (listed.has(item.messageId)) return { ...item, delivery: "waiting", queuedSeen: true };
					// 不在列表里了：**只有之前在某一份列表里见过的**才算送到了（没送到的先有 `steer_dropped`）。没见过的不算：晚到的
					// 旧队列里本来就没有它；刷新后读到的（`unknown`）也不算——它可能还没到助手服务手上（这一轮的 `prompt` 还没得到
					// 回应、转发还在路上），这时另一句送到了，列表里没有它不等于它送到了。它留着不知道，在一份列表里见到了才变成
					// 等待送达，这一轮结束时照 `steer_dropped` 的有无定。
					return item.queuedSeen ? { ...item, delivery: "delivered" } : item;
				}),
			};
		}
		case "turn_queued": {
			const queue = { position: event.position, waitingFor: event.waiting_for };
			// 空闲的会话说的话排队了（还在等它的 `turn_started`）：会话变成排队中。
			if ((state.status === "idle" || state.status === "queued") && state.awaitingStart) {
				return { ...state, status: "queued", queue };
			}
			// 排在这一轮后面的话（会话仍在做）：位置前进了。
			if (state.status === "running" && hasBehind(state.items)) return { ...state, queue };
			// 其余是晚到的（补发的次序，属于已经过去的一轮）：不算。
			return state;
		}
		case "turn_end": {
			// 同一轮只有一个结局（控制面只记第一条，后到的不记、不发布）：这一轮的结局已经画过，后来的（旧版本留下的、
			// 重复的）不再画一行；下一轮在做时，上一轮迟到的重复结局也不能把会话改回空闲。
			if (state.items.some((item) => item.kind === "turn_end" && item.turn === event.turn)) {
				return state;
			}
			const settled = finishStreaming(state);
			// 一轮结束时还没有 `steer_dropped` 的插话都送到了（协议「不变式」）；排着话的会话这时是排队中，轮到它时 `turn_started` 开始它。
			const finished = settled.items.map((item): TimelineItem => {
				if (item.kind === "tool" && item.result === null) return { ...item, abandoned: true };
				if (
					item.kind === "user" &&
					item.role === "steer" &&
					(item.delivery === "waiting" || item.delivery === "unknown")
				) {
					return { ...item, delivery: "delivered" };
				}
				return item;
			});
			return {
				...state,
				...settled,
				thinking: false,
				turnOpen: false,
				awaitingStart: hasBehind(finished),
				steerQueue: [],
				// 会话已经结束就保持结束（`session_ended` 比这一轮的 `turn_end` 晚到的情况不存在，稳妥起见）。
				status: state.status === "ended" ? "ended" : hasBehind(finished) ? "queued" : "idle",
				queue: hasBehind(finished) ? state.queue : null,
				items: [
					...finished,
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
			return {
				...state,
				status: "ended",
				thinking: false,
				turnOpen: false,
				awaitingStart: false,
				steerQueue: [],
				queue: null,
				items: [
					...state.items,
					{
						kind: "session_ended",
						key: `e${event.seq}`,
						seq: event.seq,
						at: event.at,
						by: event.by,
					},
				],
			};
		case "platform":
			// 只有 `commit` 渲染；`scenario_version`、`run` 在 #547（成果栏）里用。
			if (event.kind !== "commit") return state;
			return {
				...state,
				items: [
					...state.items,
					{
						kind: "commit",
						key: `e${event.seq}`,
						seq: event.seq,
						at: event.at,
						turn: event.turn,
						leftover: state.currentTurn > 0 && event.turn < state.currentTurn,
						hash: event.hash,
						files: event.files,
						diff: event.diff,
						truncated: event.truncated,
					},
				],
			};
		default:
			// tool_output、snapshot，以及以后才有的类型：这一版不渲染。
			return state;
	}
}

/**
 * 会话页打开时的状态：会话视图里的状态，加上最近一页持久事件（序号升序）。状态以会话视图为准（那是读取这一刻的），
 * 不由这一页历史推出来；`hasMore` 是接口的 `has_more`。
 */
export function initialTimeline(
	status: SessionStatus,
	events: readonly SessionEvent[],
	hasMore: boolean,
	queue: TimelineQueue | null = null,
): TimelineState {
	const built = events.reduce(applyEvent, emptyTimeline(status, null, startsInTurn(events)));
	// 在做、而且视图里有排位：有话排在这一轮后面（停止途中说的）。这一页里没有这一轮的 `turn_started`（在更早的一页）时按事件认不出
	// 它，那句话是最后一句不是插话的话。
	const markBehind = status === "running" && queue !== null && !hasBehind(built.items);
	const items = markBehind ? markLastTurnWordsBehind(built.items) : built.items;
	return {
		...built,
		status,
		thinking: false,
		hasMore,
		// 有一轮在进行取自会话视图（读取这一刻的），不由这一页历史推出来；排位和在等谁也取自视图。
		turnOpen: status === "running",
		awaitingStart: status === "queued" || (status === "running" && hasBehind(items)),
		steerQueue: [],
		queue,
		items: resolveSteers(items),
	};
}

/**
 * 说话之后核对的会话视图说这个会话在排队（`status` 为 `queued`、有排位）：空闲的会话说的话排上了队、项目里没有会话在做时控制面不推
 * `turn_queued`（要等这一刻开始才推；暂停着的项目要等兜底），页面自己从视图里得知。`after` 是**发出这句话时**页面上最大的序号：
 * 视图是在控制面取的，回应到浏览器之前这句话可能已经开始又结束了（`turn_end`），或者被移出了队列（`queue_cancelled`），这些事件比视图新，
 * **以事件为准，不用这份视图**（序号大于 `after` 的结局或撤掉）。只对空闲或排队中的有效：已经在做、已经结束的（开始的事件比响应先到）不改。
 * 这句话自己的 `user_message` 比视图先到是常态（序号也大于 `after`），不算。
 */
export function applyQueuedView(
	state: TimelineState,
	queue: TimelineQueue,
	after: number,
): TimelineState {
	if (state.status !== "idle" && state.status !== "queued") return state;
	const settled = state.items.some(
		(item) =>
			"seq" in item &&
			item.seq !== null &&
			item.seq > after &&
			(item.kind === "turn_end" ||
				(item.kind === "notice" && item.noticeKind === "queue_cancelled")),
	);
	if (settled) return state;
	return { ...state, status: "queued", awaitingStart: true, queue };
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
	const older = events.reduce(applyEvent, emptyTimeline(state.status, null, startsInTurn(events)));
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
		// 只重判新读进来的这一段：在做的一轮里已经有的插话（等待送达、不知道）不能被这次读历史改掉。
		items: resolveSteers([...merged, ...rest], merged.length),
		oldestSeq:
			older.oldestSeq === null
				? state.oldestSeq
				: Math.min(older.oldestSeq, state.oldestSeq ?? older.oldestSeq),
		hasMore,
		streams: Math.max(state.streams, older.streams),
	};
}
