import type { Clock, Timer } from "../../src/clock.js";

/**
 * 手动推进的时钟：停止一轮的几个时间点（10 秒、20 秒、23 秒）不靠真的等。{@link advance} 把时间往前拨，到点的定时器按时间先后执行。
 * pi 进程、事件流这些仍是真的（真的子进程、真的 HTTP），只有助手服务自己的计时经它。
 */
export class ManualClock implements Clock {
	#now = Date.now();
	#next = 1;
	readonly #timers = new Map<number, { at: number; callback: () => void }>();

	now(): number {
		return this.#now;
	}

	setTimeout(callback: () => void, ms: number): Timer {
		const id = this.#next++;
		this.#timers.set(id, { at: this.#now + Math.max(0, ms), callback });
		return id as unknown as Timer;
	}

	clearTimeout(timer: Timer | undefined): void {
		if (timer !== undefined) this.#timers.delete(timer as unknown as number);
	}

	/** 把时间往前拨 `ms`，到点的定时器按时间先后执行（执行中新加的、也到点的一并执行）。 */
	advance(ms: number): void {
		const target = this.#now + ms;
		for (;;) {
			const due = [...this.#timers.entries()]
				.filter(([, t]) => t.at <= target)
				.sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
			if (!due) break;
			this.#timers.delete(due[0]);
			this.#now = Math.max(this.#now, due[1].at);
			due[1].callback();
		}
		this.#now = target;
	}

	/** 还没到点的定时器有几个（测试看停止时排了哪些）。 */
	get pending(): number {
		return this.#timers.size;
	}
}
