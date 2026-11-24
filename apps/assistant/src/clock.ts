/**
 * 助手服务的计时：停止一轮的几个时间点（从决定结束的那一刻起算，协议「停止一轮」）、一轮的用时上限、结束进程的宽限、
 * 中止记号的过期都经它。测试里换成手动推进的时钟，不靠真的等十几秒（`test/support/manual-clock.ts`）。
 */
export interface Clock {
	now(): number;
	setTimeout(callback: () => void, ms: number): Timer;
	clearTimeout(timer: Timer | undefined): void;
}

/** 由 {@link Clock.setTimeout} 给出、只交还给同一个时钟的 {@link Clock.clearTimeout}。 */
export type Timer = { readonly __timer: unique symbol };

export const realClock: Clock = {
	now: () => Date.now(),
	setTimeout: (callback, ms) => setTimeout(callback, ms) as unknown as Timer,
	clearTimeout: (timer) => {
		if (timer !== undefined) clearTimeout(timer as unknown as NodeJS.Timeout);
	},
};
