// 单个 Agent 负载（4 槽位并发、stdout 刷屏）里的数据正确性与资源核对（纯逻辑）。
import { describe, expect, it } from "vitest";
import { checkLogCopies, checkNumbered, windowGrowth } from "../perf/checks.js";

describe("按行首序号核对日志行（checkNumbered）", () => {
	it("1..count 每个出现一次时不丢不重，与顺序无关", () => {
		expect(checkNumbered([3, 1, 2, 5, 4], 5)).toEqual({ missing: 0, duplicated: 0, unexpected: 0 });
	});

	it("缺的序号算丢失，重复出现的算重复，超出 1..count 或不是序号的算多余", () => {
		expect(checkNumbered([1, 2, 2, 2, 5, 0, 7, Number.NaN, 1.5], 5)).toEqual({
			missing: 2,
			duplicated: 2,
			unexpected: 4,
		});
	});

	it("一行都没有时全部丢失", () => {
		expect(checkNumbered([], 3)).toEqual({ missing: 3, duplicated: 0, unexpected: 0 });
	});
});

describe("一段时间内的占用增长（windowGrowth）", () => {
	const at = (ms: number, bytes: number) => ({ ms, bytes });

	it("以窗口里第一个采样为基准，取窗口内的峰值算增长；窗口外的采样不算", () => {
		const samples = [at(0, 0), at(1000, 4096), at(2000, 8192), at(3000, 12_288), at(9000, 999_999)];
		expect(windowGrowth(samples, 1000, 3000)).toEqual({
			baselineBytes: 4096,
			peakBytes: 12_288,
			growthBytes: 8192,
		});
	});

	it("占用在窗口里先涨后回落时仍按峰值算", () => {
		expect(windowGrowth([at(0, 100), at(1, 500), at(2, 100)], 0, 2)?.growthBytes).toBe(400);
	});

	it("只减不增时增长为 0", () => {
		expect(windowGrowth([at(0, 500), at(1, 100)], 0, 1)?.growthBytes).toBe(0);
	});

	it("窗口里没有采样时返回 null", () => {
		expect(windowGrowth([at(0, 1), at(10, 2)], 3, 7)).toBeNull();
	});
});

describe("日志副本（checkLogCopies）", () => {
	it("只统计这个流的副本（stdout.log 与 stdout.log.N），给出文件数、最大的文件与合计", () => {
		const files = [
			{ name: "stdout.log", size: 3 },
			{ name: "stdout.log.1", size: 8 },
			{ name: "stderr.log", size: 100 },
			{ name: "stdout.logger", size: 100 },
			{ name: "output.json", size: 100 },
		];
		expect(checkLogCopies(files, "stdout.log")).toEqual({
			files: 2,
			largestBytes: 8,
			totalBytes: 11,
		});
	});

	it("多出来的轮换文件也算进去", () => {
		const files = [
			{ name: "stdout.log", size: 1 },
			{ name: "stdout.log.1", size: 2 },
			{ name: "stdout.log.2", size: 3 },
		];
		expect(checkLogCopies(files, "stdout.log")).toEqual({
			files: 3,
			largestBytes: 3,
			totalBytes: 6,
		});
	});

	it("没有副本时都是 0", () => {
		expect(checkLogCopies([], "stdout.log")).toEqual({ files: 0, largestBytes: 0, totalBytes: 0 });
	});
});
