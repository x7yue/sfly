import type { PersistedSessionEvent, SessionEvent } from "@sfly/schema";

/** 补发时一次从库里读多少条事件。 */
export const REPLAY_BATCH = 200;

/**
 * 补发期间最多缓冲多少条实时事件。补发要等客户端读走一批才发下一批，客户端慢的时候实时事件会堆在这里；
 * 堆过这个数就关掉这条流，让客户端带着 `Last-Event-ID` 重连（已经收到的持久事件不会重复，不持久的由快照补上）。
 */
export const LIVE_BUFFER_LIMIT = 5_000;

/** 补发期间缓冲的实时事件超过了上限：这条流要关掉让客户端重连。 */
export class FollowOverflowError extends Error {
	constructor(readonly limit: number) {
		super(
			`补发期间缓冲的实时事件超过 ${limit} 条（客户端读得太慢），关掉这条流让它带 Last-Event-ID 重连`,
		);
	}
}

/** {@link follow} 的数据源：订阅实时事件，和按序号读库。 */
export interface FollowSource {
	/** 订阅这个会话之后发布的事件（持久的已经落库、带 `seq` 和 `at`），返回取消订阅的函数。 */
	subscribe(listener: (event: SessionEvent) => void): () => void;
	/** 序号大于 `after` 的持久事件，序号升序，最多 `limit` 条。 */
	read(after: number, limit: number): Promise<PersistedSessionEvent[]>;
	/**
	 * 补发读完、切到实时的那一刻调用（**同步**，不能等任何东西：和切换在同一步里，之间不会漏进新事件）：返回要发给这一条连接的
	 * `snapshot`；没有时（数据源不提供）不发。{@link follow} 把它放在缓冲的实时事件放完**之后**，所以它里面的状态已经包括了补发期间到的
	 * 增量；页面按「取代」处理它（重叠的部分不会重复）。
	 */
	snapshot?(): SessionEvent | undefined;
}

/** {@link follow} 的出口：一条 SSE 流。 */
export interface FollowSink {
	emit(event: SessionEvent): void;
	/** 写出去的还没被对端读走时，等它读走（流结束时也放行）；补发每发完一批等一次。 */
	drained(): Promise<void>;
}

export interface FollowOptions {
	/** 补发一批读多少条，默认 {@link REPLAY_BATCH}。 */
	batch?: number;
	/** 补发期间最多缓冲多少条实时事件，默认 {@link LIVE_BUFFER_LIMIT}。 */
	maxBuffered?: number;
}

/**
 * 实时推送一个会话的事件（`GET /sessions/:id/events`）：先订阅、再从库里补发，补发完接上实时的。
 * `after` 是已经收到的最大序号（0 表示从头开始）。保证：
 * - **持久的事件不重不漏**：补发期间到的实时事件（持久的和不持久的，按到达先后）先缓冲，补发完按原来的相对顺序放出；
 *   实时事件不改动「补发读到哪」，所以补发的下一批不会被它带着跳过；缓冲里序号已经补发过的持久事件丢掉（按 `seq` 去重）；
 * - **不持久的事件不会跑到取代它的持久事件后面**：缓冲里的不持久事件，如果它后面有一条**已经补发过的、取代它的持久事件**，
 *   就当作已经过时丢掉，只放出没有被取代的。「取代」按事件的内容定：文字增量和思考属于它之后落库的
 *   那条完整的助手消息（`assistant_message`），工具输出属于同一次调用的结果（`tool_result`，`call_id` 一样）；这条完整的
 *   消息已经补发了，增量就是过时的，放出来会让页面在完整的消息后面又多出一段半截的文字。**别的持久事件取代不了增量**：
 *   一轮进行中用户插话（`user_message`）、助手服务的提示（`notice`）、平台记录、一轮的开始，都会落在一条消息的增量中间
 *   （#544），它们不带这条消息的内容，增量前后夹着它们时，前半截增量也要留下，不然页面上这条消息只有后半截，要等整条消息
 *   落库才被换成完整的。（以前按先后判断——排在已经补发过的任何持久事件前面的增量都丢——假设增量中间不会夹着别的持久事件，
 *   插话让这个假设不成立。）其余不持久的事件（`steer_queue`、`turn_queued`）每条都是完整的当前状态，按到达的
 *   先后放出，最后一条为准，不判断过时；
 * - **快照**（#545）：补发读完、切到实时的那一刻，缓冲的实时事件放完之后，**只给这一条连接**发一条 `snapshot`
 *   （{@link FollowSource.snapshot}，同步生成）；带 `after` 重连的连接也一样。它发在补发**之后**：快照里的 `partial_text` 是相对「上一条
 *   持久的助手消息」的，页面要先读完补发才知道是哪一条；发在前面会被补发里的那条整条消息盖掉。它也发在缓冲的实时事件**之后**：
 *   快照在放完缓冲之后生成，里面已经包括了补发期间到的增量，页面按「取代」处理，不会重复；
 *   它不持久，没有序号，不参与去重；
 *   助手事件的「落库加发布」和补发读库在这个会话的链上依次执行（`SessionStore.#serial`），所以缓冲里排在前面的一定先于它发布，
 *   助手事件不会「已经提交、还没发布就被补发读到」；**平台记录除外**：它的写在会话令牌的请求里，提交之后才交给链推送，补发读库
 *   可能读到一条已经提交、还没推出来的平台记录，补发给了客户端；之后实时推出来的这一条按 `seq` 去重丢掉（不重不漏仍成立）。
 *   （SessionStore 保证持久事件推送的顺序等于序号的顺序，平台记录也一样；平台记录夹在一条消息的增量中间时，前半截增量也留下，
 *   见上一条）；
 * - **慢客户端不会把整段历史顶进内存**：补发每发完一批等 {@link FollowSink.drained}，期间实时事件的缓冲有上限
 *   （{@link FollowOptions.maxBuffered}），超过就用 {@link FollowOverflowError} 报错并结束。
 *
 * 不持久的事件没有序号，不推进「已经发到哪」。返回取消订阅的函数；读库出错或缓冲溢出时调用 `onError`，之后不再推送。
 * 补发完成之后（实时阶段）事件直接写给出口，不再缓冲。
 */
export function follow(
	source: FollowSource,
	after: number,
	sink: FollowSink,
	onError: (error: unknown) => void,
	options: FollowOptions = {},
): () => void {
	const batchSize = options.batch ?? REPLAY_BATCH;
	const maxBuffered = options.maxBuffered ?? LIVE_BUFFER_LIMIT;
	let stopped = false;
	let replaying = true;
	let sent = after;
	const pending: SessionEvent[] = [];

	const deliver = (event: SessionEvent) => {
		if (stopped) return;
		if ("seq" in event) {
			if (event.seq <= sent) return;
			sent = event.seq;
		}
		sink.emit(event);
	};

	let unsubscribe: (() => void) | undefined;
	const stop = () => {
		stopped = true;
		unsubscribe?.();
	};
	const fail = (error: unknown) => {
		if (stopped) return;
		stop();
		onError(error);
	};

	unsubscribe = source.subscribe((event) => {
		if (stopped) return;
		if (!replaying) return deliver(event);
		if (pending.length >= maxBuffered) return fail(new FollowOverflowError(maxBuffered));
		pending.push(event);
	});

	const replay = async () => {
		for (;;) {
			const batch = await source.read(sent, batchSize);
			if (stopped) return;
			for (const event of batch) deliver(event);
			if (batch.length < batchSize) break;
			await sink.drained();
			if (stopped) return;
		}
		// 以下不能有 await：读库返回到切换成实时阶段之间不能漏进新事件。
		replaying = false;
		// 后面有一条已经补发过的、取代它的持久事件的不持久事件已经过时（取代的规则见上面）：从后往前扫，记下
		// 后面已经补发过的完整消息和工具结果；持久的重复由 deliver 按 seq 丢。
		const buffered = pending.splice(0);
		const superseded = new Set<number>();
		let messageSent = false;
		const resultsSent = new Set<string>();
		for (let index = buffered.length - 1; index >= 0; index--) {
			const event = buffered[index] as SessionEvent;
			if ("seq" in event) {
				if (event.seq > sent) continue;
				// `sent` 是补发读到的最大序号，实时事件里序号不超过它的，补发已经带过了。
				if (event.type === "assistant_message") messageSent = true;
				else if (event.type === "tool_result") resultsSent.add(event.call_id);
				continue;
			}
			if (
				((event.type === "assistant_delta" || event.type === "thinking") && messageSent) ||
				(event.type === "tool_output" && resultsSent.has(event.call_id))
			) {
				superseded.add(index);
			}
		}
		for (const [index, event] of buffered.entries()) {
			if (superseded.has(index)) continue;
			deliver(event);
		}
		// 快照在缓冲的事件放完之后生成：此刻的状态已经包括它们。
		const snapshot = source.snapshot?.();
		if (snapshot !== undefined) deliver(snapshot);
	};
	replay().catch(fail);
	return stop;
}
