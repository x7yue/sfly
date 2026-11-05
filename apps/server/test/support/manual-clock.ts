import type { Clock } from "../../src/clock.js";

/** 手动推进的时钟：测试里替代系统时钟，时间只在调用 set/advance 时变化。 */
export class ManualClock implements Clock {
	#now: number;

	constructor(start: Date | string = "2026-01-01T00:00:00.000Z") {
		this.#now = new Date(start).getTime();
	}

	now(): Date {
		return new Date(this.#now);
	}

	set(time: Date | string): void {
		this.#now = new Date(time).getTime();
	}

	advance(ms: number): void {
		this.#now += ms;
	}
}
