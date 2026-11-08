// 基准测试：SDK 单次 ctx.metric() 的开销（ARCHITECTURE §7.6；标准库 timeit，不给 SDK 加依赖，ADR 0002）。
// 运行 sdk/python/benchmarks/metric.py --json（也可以单独运行，见该文件），只记录，不判定。
import { readTimeit } from "../bench.js";
import { runChecked } from "../command.js";
import { definePerfItem, type ItemRun } from "../item.js";
import type { Measurement } from "../report.js";

/** 脚本里的情况 → 报告里的名称。 */
const CASES: Record<string, string> = {
	metric: "单次 ctx.metric() 耗时",
	labeled_metric: "单次带标签的 ctx.metric() 耗时（4 个指标 × 50 个进程，标签 pid、name）",
};

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
		const measurements: Measurement[] = result.cases.flatMap((c) => {
			const label = CASES[c.id] ?? c.id;
			return [
				{
					id: `${c.id}_call_us`,
					label: `${label}（各轮中位数）`,
					value: c.medianUs,
					unit: "µs",
					noise: 0.5,
				},
				{
					id: `${c.id}_call_best_us`,
					label: `${label}（最好的一轮）`,
					value: c.bestUs,
					unit: "µs",
					noise: 0.5,
				},
			];
		});
		const calls = result.cases.map((c) => `${CASES[c.id] ?? c.id} 每轮 ${c.calls} 次`).join("，");
		return {
			measurements,
			notes: [
				`Python ${result.python}，${result.repeat} 轮（${calls}）；事件写普通文件，不经过 Agent 的 FIFO。`,
			],
		};
	},
});
