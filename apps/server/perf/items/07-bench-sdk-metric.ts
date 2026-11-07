// 基准测试：SDK 单次 ctx.metric() 的开销（ARCHITECTURE §7.6；标准库 timeit，不给 SDK 加依赖，ADR 0002）。
// 运行 sdk/python/benchmarks/metric.py --json（也可以单独运行，见该文件），只记录，不判定。
import { readTimeit } from "../bench.js";
import { runChecked } from "../command.js";
import { definePerfItem, type ItemRun } from "../item.js";

export default definePerfItem({
	id: "bench-sdk-metric",
	title: "基准测试：SDK 单次 ctx.metric()",
	scope: null,
	needsArtifacts: false,
	async run(ctx): Promise<ItemRun> {
		ctx.log("timeit 测量 ctx.metric()");
		const stdout = await runChecked(
			"uv",
			["run", "--locked", "python", "sdk/python/benchmarks/metric.py", "--json"],
			{ cwd: ctx.repoRoot, signal: ctx.signal, capture: true },
		);
		const result = readTimeit(stdout);
		return {
			measurements: [
				{
					id: "metric_call_us",
					label: "单次 ctx.metric() 耗时（各轮中位数）",
					value: result.medianUs,
					unit: "µs",
					noise: 0.5,
				},
				{
					id: "metric_call_best_us",
					label: "单次 ctx.metric() 耗时（最好的一轮）",
					value: result.bestUs,
					unit: "µs",
					noise: 0.5,
				},
			],
			notes: [
				`Python ${result.python}，${result.repeat} 轮 × 每轮 ${result.calls} 次；事件写普通文件，不经过 Agent 的 FIFO。`,
			],
		};
	},
});
