import { describe, expect, it } from "vitest";
import { formatClockOffset, formatDuration } from "./format";

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
