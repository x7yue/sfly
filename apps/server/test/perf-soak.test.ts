// 长时负载测试（pnpm perf:soak）里的纯逻辑：长时间的指标序列分段查询、随时间缓慢增长的判断。
import { describe, expect, it } from "vitest";
import { lateGrowth, lateMedianGrowth, secondWindows } from "../perf/checks.js";

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

describe("后半段比前半段多出的中位数（lateMedianGrowth，看积压是否随时间增长）", () => {
	const at = (values: number[]) => values.map((v, i): [number, number] => [i * 1000, v]);

	it("一次性的尖峰（例如一批指标段同时写库）不算增长", () => {
		// 前半段 [0, 3500) 中位数 100，后半段 [3500, 7000] 是 100、5000、100、100，中位数 100。
		expect(lateMedianGrowth(at([100, 100, 100, 100, 100, 5000, 100, 100]))).toBe(0);
	});

	it("一直在涨（处理不过来、越积越多）时为正", () => {
		// 前半段 0、100、200、300 的中位数 150，后半段 400–700 的中位数 550。
		expect(lateMedianGrowth(at([0, 100, 200, 300, 400, 500, 600, 700]))).toBe(400);
	});

	it("按时间对半分，奇数个采样也一样", () => {
		// 中点 1000：前半段只有 10，后半段 30、20 的中位数 25。
		expect(lateMedianGrowth(at([10, 30, 20]))).toBe(15);
	});

	it("少于两个采样时没法分成两半，返回 null", () => {
		expect(lateMedianGrowth([])).toBeNull();
		expect(lateMedianGrowth([[0, 1]])).toBeNull();
	});
});
