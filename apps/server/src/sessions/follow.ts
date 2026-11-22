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
 * - **不持久的事件不会跑到它之后的持久事件后面**：缓冲里排在「已经补发过的持久事件」前面的不持久事件，当作已经过时丢掉，
 *   只放出排在后面的。**这个判断有一个假设**：一条不持久的事件（文字增量、思考、工具输出）只属于它*之后*落库的那条
 *   持久事件（增量之后跟着完整的 `assistant_message`、`tool_result`），所以它前面已经补发过的持久事件把它的内容带全了。
 *   假设成立的前提，是助手服务不会在一条消息的增量中间插进一条无关的持久事件（`notice`、`platform` 等）；现在的助手服务
 *   一轮里的事件是顺序产生的，满足它。**不成立的时候**：一条还没落库的消息的增量，排在一条无关的、已经补发过的持久事件前面，
 *   会被当作过时丢掉，页面上这条消息少一段半截的文字（刷新后读库能补回来，完整的消息不受影响）。#544 的插话
 *   （一轮进行中用户又说了话、落一条 `user_message`）会让这种交错出现，到那时这条规则要改成按
 *   「增量属于哪条消息」来判断，不能再只看先后；
 *   「落库加发布」和补发读库在这个会话的链上依次执行（`SessionStore.#serial`），所以缓冲里排在前面的一定先于它发布，
 *   「已经提交、还没发布就被补发读到」的事件不会出现；
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
		// 排在最后一条「已经补发过」的持久事件前面的不持久事件已经过时；持久的重复由 deliver 按 seq 丢。
		let covered = -1;
		for (const [index, event] of pending.entries()) {
			if ("seq" in event && event.seq <= sent) covered = index;
		}
		for (const [index, event] of pending.splice(0).entries()) {
			if (index < covered && !("seq" in event)) continue;
			deliver(event);
		}
	};
	replay().catch(fail);
	return stop;
}
