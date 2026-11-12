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
 * 每个机器人的发送限速（滑动窗口）：任意一个 {@link RATE_LIMITS} 的窗口里，已经发出的请求数达到上限，就要等。
 * 重试也是请求，同样计数。只记在内存里：控制面重启后从头算，多发出的那一点会被飞书的限流错误码 11232 接住，
 * 由退避重试处理。
 */
export class SendRateLimiter {
	readonly #sent = new Map<string, number[]>();

	/**
	 * 现在能给这个机器人发一个请求吗？能：记下这次发送，返回 0；不能：不记录，返回至少还要等多少毫秒。
	 * 窗口是 `(now - windowMs, now]`；比 `now` 还晚的记录（控制面时间往回跳了）作废。
	 */
	acquire(bot: string, now: number): number {
		const times = (this.#sent.get(bot) ?? []).filter(
			(time) => time <= now && time > now - LONGEST_WINDOW_MS,
		);
		let wait = 0;
		for (const { windowMs, max } of RATE_LIMITS) {
			const inWindow = times.filter((time) => time > now - windowMs);
			const blocking = inWindow[inWindow.length - max];
			if (blocking !== undefined) wait = Math.max(wait, blocking + windowMs - now);
		}
		if (wait > 0) {
			this.#store(bot, times);
			return wait;
		}
		this.#store(bot, [...times, now]);
		return 0;
	}

	#store(bot: string, times: number[]): void {
		if (times.length > 0) this.#sent.set(bot, times);
		else this.#sent.delete(bot);
	}
}
