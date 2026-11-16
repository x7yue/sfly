import { describe, expect, it } from "vitest";
import { formatMetric } from "../src/index.js";

describe("指标值的写法", () => {
	it("整数原样，小数按量级留位", () => {
		expect(formatMetric(812)).toBe("812");
		expect(formatMetric(1.234)).toBe("1.23");
		expect(formatMetric(12.34)).toBe("12.3");
		expect(formatMetric(812.6)).toBe("813");
		expect(formatMetric(-0.5)).toBe("-0.50");
	});

	it("一万以上写成 k，一百万以上写成 M，十万、一千万以上不留小数", () => {
		expect(formatMetric(9999)).toBe("9999");
		expect(formatMetric(12_345)).toBe("12.3k");
		expect(formatMetric(123_456)).toBe("123k");
		expect(formatMetric(1_284_814)).toBe("1.3M");
		expect(formatMetric(12_845_000)).toBe("13M");
		expect(formatMetric(-1_500_000)).toBe("-1.5M");
	});
});
