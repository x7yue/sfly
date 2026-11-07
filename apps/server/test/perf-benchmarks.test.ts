// 性能测试（ARCHITECTURE §7.6）里的三个基准测试：读取各自工具的输出，换算成报告里的数值。
// 基准测试本身不进 CI，这里只检查读取与换算。
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCriterion, readTimeit, readVitestBench } from "../perf/bench.js";

describe("timeit 的结果（SDK 基准测试）", () => {
	it("每轮的单次耗时取中位数与最小值（微秒）", () => {
		const stdout = JSON.stringify({
			python: "3.12.8",
			calls: 100_000,
			repeat: 5,
			per_call_us: [3.1, 2.9, 4.5, 3.0, 3.3],
		});
		expect(readTimeit(`${stdout}\n`)).toEqual({
			python: "3.12.8",
			calls: 100_000,
			repeat: 5,
			medianUs: 3.1,
			bestUs: 2.9,
		});
	});

	it("偶数轮取中间两个的平均", () => {
		const stdout = JSON.stringify({
			python: "3.13.1",
			calls: 10,
			repeat: 4,
			per_call_us: [4, 1, 3, 2],
		});
		expect(readTimeit(stdout).medianUs).toBe(2.5);
	});

	it("输出不是预期的格式时报错并带上原文", () => {
		expect(() => readTimeit("Traceback (most recent call last): ...")).toThrow(/Traceback/);
		expect(() => readTimeit(JSON.stringify({ python: "3.12", per_call_us: [] }))).toThrow(
			"timeit 的输出",
		);
	});
});

describe("criterion 的结果（Agent 基准测试）", () => {
	const dirs: string[] = [];
	afterEach(async () => {
		await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
	});

	/** 按 criterion 的目录结构写一项结果：<组>/<函数>/new/{benchmark,estimates}.json。 */
	const writeBench = async (
		home: string,
		group: string,
		fn: string,
		throughput: Record<string, number> | null,
		meanNs: number,
		run = "new",
	) => {
		const dir = join(home, group, fn, run);
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, "benchmark.json"),
			JSON.stringify({
				group_id: group,
				function_id: fn,
				value_str: null,
				throughput,
				full_id: `${group}/${fn}`,
				directory_name: `${group}/${fn}`,
				title: `${group}/${fn}`,
			}),
		);
		await writeFile(
			join(dir, "estimates.json"),
			JSON.stringify({
				mean: {
					confidence_interval: { confidence_level: 0.95, lower_bound: 1, upper_bound: 2 },
					point_estimate: meanNs,
					standard_error: 1,
				},
				median: {
					confidence_interval: { confidence_level: 0.95, lower_bound: 1, upper_bound: 2 },
					point_estimate: meanNs * 2,
					standard_error: 1,
				},
			}),
		);
	};

	it("每个函数一项：平均每次迭代的耗时，按吞吐量换算成每秒的元素数或字节数；只读最近一次（new）", async () => {
		const home = await mkdtemp(join(tmpdir(), "crit-"));
		dirs.push(home);
		await writeBench(home, "merge", "merge_events", { Elements: 10_000 }, 250_000);
		await writeBench(home, "merge", "merge_events", { Elements: 10_000 }, 1, "base");
		await writeBench(home, "split", "split_short_lines", { Bytes: 1_048_576 }, 2_000_000);
		await writeBench(home, "plain", "plain", null, 40);

		expect(await readCriterion(home)).toEqual([
			{ id: "merge_events", meanNs: 250_000, perSecond: 40_000_000, unit: "elements" },
			{ id: "plain", meanNs: 40, perSecond: null, unit: null },
			{ id: "split_short_lines", meanNs: 2_000_000, perSecond: 524_288_000, unit: "bytes" },
		]);
	});

	it("目录里没有结果时返回空列表", async () => {
		const home = await mkdtemp(join(tmpdir(), "crit-"));
		dirs.push(home);
		expect(await readCriterion(home)).toEqual([]);
		expect(await readCriterion(join(home, "missing"))).toEqual([]);
	});
});

describe("vitest bench 的结果（控制面基准测试）", () => {
	/** json 报告里的延迟统计（毫秒），只填用到的字段。 */
	const latency = (mean: number, p99: number, samplesCount: number) => ({
		mean,
		p50: mean,
		p99,
		min: mean / 2,
		max: p99 * 2,
		samplesCount,
	});
	const report = (
		assertions: Array<{ status: string; failureMessages?: string[]; benchmarks?: unknown[] }>,
	) => ({
		success: assertions.every((a) => a.status === "passed"),
		testResults: [
			{
				name: "/repo/apps/server/bench/metrics.bench.ts",
				assertionResults: assertions.map((a, i) => ({
					fullName: `test ${i}`,
					status: a.status,
					failureMessages: a.failureMessages ?? [],
					benchmarks: a.benchmarks ?? [],
				})),
			},
		],
	});

	it("每个基准一项：平均与 p99 延迟（毫秒）和样本数，按报告里的顺序", () => {
		const json = report([
			{
				status: "passed",
				benchmarks: [
					{
						name: "写入",
						tasks: [{ name: "segment_write", latency: latency(12.5, 30, 80), rank: 1 }],
					},
				],
			},
			{
				status: "passed",
				benchmarks: [
					{ name: "a", tasks: [{ name: "query_300", latency: latency(4, 9, 200), rank: 1 }] },
					{ name: "b", tasks: [{ name: "query_12", latency: latency(1.5, 3, 500), rank: 1 }] },
				],
			},
		]);
		expect(readVitestBench(json)).toEqual([
			{ id: "segment_write", meanMs: 12.5, p99Ms: 30, samples: 80 },
			{ id: "query_300", meanMs: 4, p99Ms: 9, samples: 200 },
			{ id: "query_12", meanMs: 1.5, p99Ms: 3, samples: 500 },
		]);
	});

	it("有基准没有跑通时报错并带上失败信息（没法测下去）", () => {
		const json = report([
			{ status: "passed" },
			{ status: "failed", failureMessages: ["Error: connect ECONNREFUSED 127.0.0.1:5432"] },
		]);
		expect(() => readVitestBench(json)).toThrow(/test 1.*ECONNREFUSED/s);
	});

	it("报告里没有任何基准时报错（文件没被选中或格式变了）", () => {
		expect(() => readVitestBench(report([]))).toThrow("没有基准测试结果");
		expect(() => readVitestBench({})).toThrow("没有基准测试结果");
	});
});
