import { describe, expect, it } from "vitest";
import {
	formatClockOffset,
	formatDuration,
	formatElapsed,
	formatFullDateTime,
	formatFullDateTimeMs,
	spansOtherDay,
} from "./format";

describe("formatDuration", () => {
	it("按量级选单位", () => {
		expect(formatDuration(420)).toBe("420ms");
		expect(formatDuration(14_000)).toBe("14.0s");
		expect(formatDuration(125_000)).toBe("2m 05s");
		expect(formatDuration(2 * 3_600_000 + 5 * 60_000)).toBe("2h 05m");
	});

	it("超过一天用「天 + 小时」", () => {
		expect(formatDuration(24 * 3_600_000)).toBe("1d 00h");
		expect(formatDuration(7474 * 3_600_000 + 31 * 60_000)).toBe("311d 10h");
	});
});

describe("formatClockOffset", () => {
	const SECOND = 1000;
	const MINUTE = 60 * SECOND;
	const HOUR = 60 * MINUTE;
	const DAY = 24 * HOUR;

	it("Agent 时间比控制面快时写「快」，慢时写「慢」", () => {
		expect(formatClockOffset(3 * SECOND)).toBe("快 3 秒");
		expect(formatClockOffset(-3 * SECOND)).toBe("慢 3 秒");
	});

	it("按大小选天、小时、分钟、秒，只取最大的单位（舍去零头）", () => {
		expect(formatClockOffset(2_999)).toBe("快 2 秒");
		expect(formatClockOffset(59 * SECOND)).toBe("快 59 秒");
		expect(formatClockOffset(MINUTE)).toBe("快 1 分钟");
		expect(formatClockOffset(-(59 * MINUTE + 59 * SECOND))).toBe("慢 59 分钟");
		expect(formatClockOffset(HOUR)).toBe("快 1 小时");
		expect(formatClockOffset(-(23 * HOUR + 59 * MINUTE))).toBe("慢 23 小时");
		expect(formatClockOffset(DAY)).toBe("快 1 天");
		expect(formatClockOffset(613 * DAY + 3 * HOUR)).toBe("快 613 天");
		// Agent 时间被改到 1970 年。
		expect(formatClockOffset(-20_154 * DAY)).toBe("慢 20154 天");
	});
});

describe("formatElapsed", () => {
	it("不到 1 分钟只写秒，之后写分和秒，超过 1 小时写小时和分", () => {
		expect(formatElapsed(0)).toBe("0 秒");
		expect(formatElapsed(45_999)).toBe("45 秒");
		expect(formatElapsed(130_000)).toBe("2 分 10 秒");
		expect(formatElapsed(59 * 60_000 + 59_000)).toBe("59 分 59 秒");
		expect(formatElapsed(3_720_000)).toBe("1 小时 2 分");
	});

	it("时钟误差造成的负值按 0 秒算", () => {
		expect(formatElapsed(-1500)).toBe("0 秒");
	});
});

/** 本地时区的时刻（测试不依赖运行环境的时区）。 */
const local = (...parts: [number, number, number, number, number, number, number?]) =>
	new Date(...parts).toISOString();

describe("formatFullDateTimeMs", () => {
	it("带年份、秒和毫秒，比 formatFullDateTime 多出三位毫秒", () => {
		const time = local(2027, 8, 6, 8, 0, 14, 5);
		expect(formatFullDateTimeMs(time)).toBe("2027-09-06 08:00:14.005");
		expect(formatFullDateTime(time)).toBe("2027-09-06 08:00:14");
	});
});

describe("spansOtherDay", () => {
	const day = local(2026, 0, 1, 8, 0, 0);

	it("所有时间都和参照时间在同一天（本地时区）时为 false", () => {
		expect(
			spansOtherDay([local(2026, 0, 1, 0, 0, 0), local(2026, 0, 1, 23, 59, 59, 999)], day),
		).toBe(false);
		expect(spansOtherDay([], day)).toBe(false);
	});

	it("有一个时间不在那一天就为 true：跨过零点、差出几百天都算", () => {
		expect(spansOtherDay([local(2026, 0, 1, 23, 59, 59), local(2026, 0, 2, 0, 0, 0)], day)).toBe(
			true,
		);
		expect(spansOtherDay([local(2025, 11, 31, 23, 59, 59)], day)).toBe(true);
		expect(spansOtherDay([local(2026, 0, 1, 9, 0, 0), local(2027, 8, 6, 8, 0, 14)], day)).toBe(
			true,
		);
	});

	it("没有记录的时间（null）不算", () => {
		expect(spansOtherDay([null, local(2026, 0, 1, 9, 0, 0)], day)).toBe(false);
		expect(spansOtherDay([null], day)).toBe(false);
	});
});
