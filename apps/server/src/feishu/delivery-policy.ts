/**
 * 投递的取值和规则（ADR 0020）：退避重试的间隔和期限、每个机器人的发送限速、积压的上限。
 * 时间一律是控制面时间（ADR 0018，毫秒），调用方从注入的时钟取，这里不读时钟。
 */

/** 从入队算起超过这么久还没送达，就不再重试，记为失败。 */
export const RETRY_DEADLINE_MS = 10 * 60_000;

/** 单个机器人排队的消息超过这么多条时，丢弃最旧的。 */
export const BACKLOG_LIMIT = 1000;

const FIRST_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 60_000;

/**
 * 排好的下一次尝试到点了吗？没排过（null）或已经到了就是到点了。排的时间比现在晚得多（超过最长的退避间隔）说明
 * 控制面时间往回跳了：不等，马上重试（重试本身受限速约束）。
 */
export function isRetryDue(nextAttemptAt: Date | null, now: number): boolean {
	if (nextAttemptAt === null) return true;
	const wait = nextAttemptAt.getTime() - now;
	return wait <= 0 || wait > MAX_RETRY_DELAY_MS;
}

/** 第 `attempt` 次尝试（从 1 开始）失败之后，等多久重试：从 1 秒起逐次翻倍，最长 60 秒。 */
export function retryDelayMs(attempt: number): number {
	const doublings = Math.min(Math.max(attempt - 1, 0), 16);
	return Math.min(FIRST_RETRY_DELAY_MS * 2 ** doublings, MAX_RETRY_DELAY_MS);
}

/** 飞书对一个自定义机器人的限制：每秒 5 条、每分钟 100 条。 */
const RATE_LIMITS = [
	{ windowMs: 1000, max: 5 },
	{ windowMs: 60_000, max: 100 },
] as const;
const LONGEST_WINDOW_MS = 60_000;

/**
 * 每个机器人的发送限速（滑动窗口）：任意一个 {@link RATE_LIMITS} 的窗口里，已经有了结果的请求数达到上限，就要等。
 * 重试也是请求，同样计数；失败和超时的请求也算，它们可能已经到了飞书。只记在内存里：控制面重启后从头算，
 * 多发出的那一点会被飞书的限流错误码 11232 接住，由退避重试处理。
 *
 * 飞书按收到请求的时刻计数，我们看不到那一刻，只知道它落在发出和响应回来之间。同一个机器人的请求一个接一个地发，
 * 所以按响应回来（或失败、超时）的时刻记：下一个请求发出时，离 5 个之前的请求结束已满 1 秒，
 * 飞书收到它的时刻就一定比收到那个请求的时刻晚满 1 秒，不论请求在路上耗了多久。按发出的时刻记做不到这一点：
 * 前面的请求在路上多耗的时间，会让它被飞书收到得更晚，和后面的请求挤进同一个窗口。
 */
export class SendRateLimiter {
	readonly #ended = new Map<string, number[]>();

	/**
	 * 现在能给这个机器人发一个请求吗？能返回 0，不能返回至少还要等多少毫秒。只查不记，发出去的请求由调用方在
	 * 有了结果之后用 {@link record} 记下。窗口是 `(now - windowMs, now]`；比 `now` 还晚的记录（控制面时间往回跳了）不算。
	 */
	waitMs(bot: string, now: number): number {
		const times = (this.#ended.get(bot) ?? []).filter(
			(time) => time <= now && time > now - LONGEST_WINDOW_MS,
		);
		let wait = 0;
		for (const { windowMs, max } of RATE_LIMITS) {
			const inWindow = times.filter((time) => time > now - windowMs);
			const blocking = inWindow[inWindow.length - max];
			if (blocking !== undefined) wait = Math.max(wait, blocking + windowMs - now);
		}
		return wait;
	}

	/** 记下这个机器人的一个请求在 `endedAt` 有了结果（响应回来、失败或超时）。比 `endedAt` 还晚的记录作废。 */
	record(bot: string, endedAt: number): void {
		const times = (this.#ended.get(bot) ?? []).filter(
			(time) => time <= endedAt && time > endedAt - LONGEST_WINDOW_MS,
		);
		this.#ended.set(bot, [...times, endedAt]);
	}
}
