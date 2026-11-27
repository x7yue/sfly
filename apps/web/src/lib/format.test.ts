import { describe, expect, it } from "vitest";
import {
	errorText,
	formatClockOffset,
	formatDateTimeWithYear,
	formatDuration,
	formatElapsed,
	formatFullDateTime,
	formatFullDateTimeMs,
	formatProgress,
	spansOtherDay,
	valueText,
} from "./format";

describe("formatProgress（#806）", () => {
	it("总数是整数时当前值取整", () => {
		expect(formatProgress(70.32576644897927, 1500)).toBe("70/1500");
		expect(formatProgress(229.9794373550103, 1500)).toBe("230/1500");
		expect(formatProgress(3, 10)).toBe("3/10");
	});

	it("总数是小数时两边最多 1 位小数", () => {
		expect(formatProgress(1.23456, 2.5)).toBe("1.2/2.5");
		expect(formatProgress(2, 7.125)).toBe("2/7.1");
	});

	it("没有总数时只写当前值，最多 1 位小数", () => {
		expect(formatProgress(377.6008894639672, null)).toBe("377.6");
		expect(formatProgress(42, null)).toBe("42");
	});

	it("一万以上照指标值的写法", () => {
		expect(formatProgress(12_345.678, 1_000_000)).toBe("12.3k/1.0M");
		expect(formatProgress(250_000, null)).toBe("250k");
	});

	it("可以换分隔符", () => {
		expect(formatProgress(40.4, 100, " / ")).toBe("40 / 100");
	});
});

describe("valueText", () => {
	it("字符串原样，其余按 JSON，字符串和数字不会混淆", () => {
		expect(valueText("10.0.0.8")).toBe("10.0.0.8");
		expect(valueText("50")).toBe("50");
		expect(valueText(50)).toBe("50");
		expect(valueText(true)).toBe("true");
		expect(valueText({ mode: "fast" })).toBe('{"mode":"fast"}');
		expect(valueText(null)).toBe("null");
	});
});

describe("errorText", () => {
	it("错误取它的说明，其他值转成文字", () => {
		expect(errorText(new Error("名称不能重复"))).toBe("名称不能重复");
		expect(errorText("断网了")).toBe("断网了");
	});
});

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

describe("formatElapsed", () => {
	it("每秒刷新的时长：一分钟以内只写整秒，之后写分秒、时分", () => {
		expect(formatElapsed(0)).toBe("0s");
		expect(formatElapsed(2400)).toBe("2s");
		expect(formatElapsed(59_999)).toBe("59s");
		expect(formatElapsed(130_000)).toBe("2m 10s");
		expect(formatElapsed(3_720_000)).toBe("1h 02m");
	});

	it("时间倒退（读数早于最后一个点）当作 0", () => {
		expect(formatElapsed(-5000)).toBe("0s");
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

/** 本地时区的时刻（测试不依赖运行环境的时区）。 */
const local = (...parts: [number, number, number, number, number, number, number?]) =>
	new Date(...parts).toISOString();

describe("formatDateTimeWithYear", () => {
	it("总是带年份、不带秒：今年的和明年的写法一样", () => {
		expect(formatDateTimeWithYear(local(2026, 10, 23, 9, 5, 59))).toBe("2026-11-23 09:05");
		expect(formatDateTimeWithYear(local(2027, 0, 3, 18, 30, 0))).toBe("2027-01-03 18:30");
	});
});

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
