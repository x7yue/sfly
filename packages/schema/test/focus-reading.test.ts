import { describe, expect, it } from "vitest";
import {
	focusChartMissing,
	focusLatestSeriesName,
	focusSeriesName,
	focusValueText,
	type RunFocusItem,
} from "../src/index.js";

type Reading = Pick<RunFocusItem, "latest" | "metrics">;

const reading = (patch: Partial<Reading> = {}): Reading => ({
	latest: { value: 1_284_814, metric: "orders", labels: {}, at: "2026-01-01T00:00:00.000Z" },
	metrics: [{ name: "orders", label_keys: [] }],
	...patch,
});

describe("关注项读数的写法", () => {
	it("图表不存在的说法", () => {
		expect(focusChartMissing("吞吐")).toBe("这个版本的节点没有图表 吞吐");
	});

	it("最新值：用指标值的写法，没有数据写破折号", () => {
		expect(focusValueText(reading())).toBe("1.3M");
		expect(focusValueText(reading({ latest: null }))).toBe("—");
	});

	it("序列的名字：只有一个不带标签的序列时没有；多个指标写指标名，带标签写标签值（按声明的标签键的顺序）", () => {
		expect(focusLatestSeriesName(reading())).toBe("");
		expect(focusLatestSeriesName(reading({ latest: null }))).toBe("");
		const cpu = reading({
			metrics: [{ name: "cpu", label_keys: ["pid", "host"] }],
			latest: { value: 3, metric: "cpu", labels: { host: "a", pid: "100" }, at: "x" },
		});
		expect(focusLatestSeriesName(cpu)).toBe("100 · a");
		const both = reading({
			metrics: [
				{ name: "p50", label_keys: [] },
				{ name: "p99", label_keys: [] },
			],
			latest: { value: 3, metric: "p99", labels: {}, at: "x" },
		});
		expect(focusLatestSeriesName(both)).toBe("p99");
		expect(focusSeriesName(both, { metric: "p50", labels: {} })).toBe("p50");
	});
});
