// 三个基准测试（ARCHITECTURE §7.6）的输出读取：各自用自己的工具（timeit、criterion、vitest bench），
// 这里把它们的结果换算成统一的数值，由 perf/items/07–09 写进报告。单测见 test/perf-benchmarks.test.ts。
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** SDK 基准测试（sdk/python/benchmarks/metric.py --json）的结果。 */
export interface TimeitResult {
	python: string;
	repeat: number;
	/** 每种情况（`metric` 不带标签、`labeled_metric` 带标签）一项，顺序同脚本输出。 */
	cases: TimeitCase[];
}

export interface TimeitCase {
	id: string;
	/** 每轮调用 ctx.metric() 的次数（timeit 自动选定）。 */
	calls: number;
	/** 各轮单次耗时的中位数（微秒）。 */
	medianUs: number;
	/** 各轮单次耗时的最小值（微秒）：最接近不受干扰时的开销。 */
	bestUs: number;
}

/** 读取 SDK 基准测试脚本的 JSON 输出；格式不对时抛出错误并带上原文。 */
export function readTimeit(stdout: string): TimeitResult {
	let parsed: { python?: unknown; repeat?: unknown; cases?: unknown };
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new Error(`timeit 的输出不是 JSON：${stdout.slice(0, 2000)}`);
	}
	const missing = () => new Error(`timeit 的输出缺少字段：${stdout.slice(0, 2000)}`);
	const { python, repeat, cases } = parsed;
	if (
		typeof python !== "string" ||
		typeof repeat !== "number" ||
		!Array.isArray(cases) ||
		cases.length === 0
	) {
		throw missing();
	}
	return {
		python,
		repeat,
		cases: cases.map((c: { id?: unknown; calls?: unknown; per_call_us?: unknown }) => {
			const perCall = c.per_call_us;
			if (
				typeof c.id !== "string" ||
				typeof c.calls !== "number" ||
				!Array.isArray(perCall) ||
				perCall.length === 0 ||
				!perCall.every((v) => typeof v === "number")
			) {
				throw missing();
			}
			const sorted = [...(perCall as number[])].sort((a, b) => a - b);
			const mid = Math.floor(sorted.length / 2);
			return {
				id: c.id,
				calls: c.calls,
				medianUs:
					sorted.length % 2 === 1
						? (sorted[mid] as number)
						: ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2,
				bestUs: sorted[0] as number,
			};
		}),
	};
}

/** criterion 的一项结果。 */
export interface CriterionResult {
	/** 函数名（`bench_function` 的名字，不含组名）。 */
	id: string;
	/** 平均每次迭代的耗时（纳秒）。 */
	meanNs: number;
	/** 按声明的吞吐量（每次迭代处理的元素数或字节数）换算的每秒处理量；没有声明时为 null。 */
	perSecond: number | null;
	unit: "elements" | "bytes" | null;
}

/** 读取 criterion 输出目录（`CRITERION_HOME`，默认 target/criterion）里每项最近一次（new）的结果，按 id 排序。 */
export async function readCriterion(home: string): Promise<CriterionResult[]> {
	const results: CriterionResult[] = [];
	const groups = await readdir(home, { withFileTypes: true }).catch(() => []);
	for (const group of groups) {
		if (!group.isDirectory() || group.name === "report") continue;
		const functions = await readdir(join(home, group.name), { withFileTypes: true });
		for (const fn of functions) {
			const dir = join(home, group.name, fn.name, "new");
			let benchmark: { function_id: string; throughput: Record<string, number> | null };
			let estimates: { mean: { point_estimate: number } };
			try {
				benchmark = JSON.parse(await readFile(join(dir, "benchmark.json"), "utf8"));
				estimates = JSON.parse(await readFile(join(dir, "estimates.json"), "utf8"));
			} catch {
				continue;
			}
			const meanNs = estimates.mean.point_estimate;
			const [kind, amount] = Object.entries(benchmark.throughput ?? {})[0] ?? [];
			const unit = kind === "Elements" ? "elements" : kind === "Bytes" ? "bytes" : null;
			results.push({
				id: benchmark.function_id,
				meanNs,
				perSecond: unit && amount !== undefined ? amount / (meanNs / 1e9) : null,
				unit,
			});
		}
	}
	return results.sort((a, b) => a.id.localeCompare(b.id));
}

/** vitest bench 的一项结果。 */
export interface VitestBenchResult {
	/** `bench(name, fn)` 的名字。 */
	id: string;
	/** 平均每次调用的耗时（毫秒）。 */
	meanMs: number;
	p99Ms: number;
	samples: number;
}

interface JsonReport {
	testResults?: Array<{
		assertionResults?: Array<{
			fullName: string;
			status: string;
			failureMessages?: string[] | null;
			benchmarks?: Array<{
				tasks: Array<{
					name: string;
					latency: { mean: number; p99: number; samplesCount: number };
				}>;
			}>;
		}>;
	}>;
}

/**
 * 读取 `vitest bench --reporter=json` 的报告（vitest 5：`test()` 里用 `bench` 夹具注册的基准）。
 * 有测试没跑通、或者报告里一项结果都没有时抛出错误。
 */
export function readVitestBench(report: unknown): VitestBenchResult[] {
	const results: VitestBenchResult[] = [];
	const failures: string[] = [];
	for (const file of (report as JsonReport).testResults ?? []) {
		for (const test of file.assertionResults ?? []) {
			if (test.status !== "passed") {
				failures.push(
					`${test.fullName}（${test.status}）：${(test.failureMessages ?? []).join("\n")}`,
				);
				continue;
			}
			for (const benchmark of test.benchmarks ?? []) {
				for (const task of benchmark.tasks) {
					results.push({
						id: task.name,
						meanMs: task.latency.mean,
						p99Ms: task.latency.p99,
						samples: task.latency.samplesCount,
					});
				}
			}
		}
	}
	if (failures.length > 0) throw new Error(`基准测试没有跑通：\n${failures.join("\n")}`);
	if (results.length === 0) throw new Error("没有基准测试结果");
	return results;
}
