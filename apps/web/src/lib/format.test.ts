import { describe, expect, it } from "vitest";
import { formatDuration } from "./format";

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
