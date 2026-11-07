// 长时负载测试（pnpm perf:soak）里的纯逻辑：长时间的指标序列分段查询、随时间缓慢增长的判断。
import { describe, expect, it } from "vitest";
import { lateGrowth, secondWindows } from "../perf/checks.js";

describe("把一段秒数切成查询窗口（secondWindows）", () => {
	it("首尾都包含，每段最多 width 秒，相邻两段首尾相接、不重叠", () => {
		expect(secondWindows(100, 109, 4)).toEqual([
			[100, 103],
			[104, 107],
			[108, 109],
		]);
	});

	it("不超过一段时只有一段；结束早于开始时没有窗口", () => {
		expect(secondWindows(100, 100, 3600)).toEqual([[100, 100]]);
		expect(secondWindows(0, 3599, 3600)).toEqual([[0, 3599]]);
		expect(secondWindows(5, 4, 10)).toEqual([]);
	});
});

describe("后半段比前半段多出的峰值（lateGrowth，看缓慢泄漏）", () => {
	it("按时间对半分：后半段的峰值减去前半段的峰值", () => {
		const points: Array<[number, number]> = [
			[0, 10],
			[1000, 30],
			[2000, 20],
			[3000, 25],
			[4000, 42],
		];
		// 前半段 [0, 2000) 峰值 30，后半段 [2000, 4000] 峰值 42。
		expect(lateGrowth(points)).toBe(12);
	});

	it("平稳或回落时为 0 或负数", () => {
		expect(
			lateGrowth([
				[0, 50],
				[1000, 50],
			]),
		).toBe(0);
		expect(
			lateGrowth([
				[0, 50],
				[1000, 40],
			]),
		).toBe(-10);
	});

	it("少于两个采样时没法分成两半，返回 null", () => {
		expect(lateGrowth([])).toBeNull();
		expect(lateGrowth([[0, 1]])).toBeNull();
	});
});
