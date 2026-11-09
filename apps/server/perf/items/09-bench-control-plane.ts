// 基准测试：控制面的指标分段写入与降采样查询耗时（ARCHITECTURE §7.6；vitest bench）。
// 运行 perf/benchmarks/control-plane.bench.ts（也可以单独运行，见该文件），需要本机 PostgreSQL。只记录；
// 一张图表的查询对照 §7.6「运行监控页的图表」的目标（与其他目标一样，差一半以上才提示）。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readVitestBench } from "../bench.js";
import { runCommand } from "../command.js";
import { definePerfItem, type ItemRun, target } from "../item.js";
import type { Measurement } from "../report.js";
import { CHART_QUERY_P95_MS } from "../targets.js";

/**
 * 基准名 → 报告里的名称、平均值的正常波动（毫秒；p99 按两倍算），以及 p99 要对照的目标（§7.6「运行监控页的图表」
 * 的 p95 目标：vitest bench 只给出 p99，p99 达标时 p95 一定达标）。
 */
const BENCHES: Record<string, { label: string; noise: number; p99Target?: number }> = {
	segment_write: { label: "分段写入（120 秒 × 10 个指标，10 段整段写入）", noise: 2 },
	query_300: { label: "降采样查询（1 小时 × 10 个指标 → 300 个桶）", noise: 10 },
	query_12: { label: "降采样查询（1 小时 × 10 个指标 → 12 个桶，用段摘要）", noise: 5 },
	segment_write_labeled: {
		label: "带标签的分段写入（120 秒 × 4 个指标 × 50 个进程，200 段整段写入）",
		noise: 20,
	},
	query_300_labeled: {
		label: "带标签的降采样查询（1 小时 × 4 个指标 × 50 个进程 → 300 个桶）",
		noise: 100,
	},
	query_300_chart_50: {
		label: "一张图表的降采样查询（1 小时 × 1 个带标签指标 × 50 个进程 → 300 个桶）",
		noise: 30,
	},
	query_300_chart_100: {
		label: "一张图表的降采样查询（1 小时 × 2 个带标签指标 × 50 个进程 → 300 个桶）",
		noise: 50,
		p99Target: CHART_QUERY_P95_MS,
	},
};

export default definePerfItem({
	id: "bench-control-plane",
	title: "基准测试：控制面指标分段写入与降采样查询",
	scope: "运行监控页的图表",
	needsArtifacts: false,
	async run(ctx): Promise<ItemRun> {
		const output = join(ctx.tmpDir, "vitest-bench.json");
		ctx.log("vitest bench");
		const { code } = await runCommand(
			"pnpm",
			[
				"exec",
				"vitest",
				"bench",
				"--run",
				"--reporter=default",
				"--reporter=json",
				`--outputFile.json=${output}`,
				"perf/benchmarks/control-plane.bench.ts",
			],
			{ cwd: join(ctx.repoRoot, "apps/server"), signal: ctx.signal },
		);
		const report = await readFile(output, "utf8").catch(() => {
			throw new Error(`vitest bench 以退出码 ${code} 结束，没有写出报告`);
		});
		const measurements: Measurement[] = readVitestBench(JSON.parse(report)).flatMap((r) => {
			const known = BENCHES[r.id];
			const label = known?.label ?? r.id;
			return [
				{
					id: `${r.id}_ms`,
					label: `${label}：平均`,
					value: r.meanMs,
					unit: "ms",
					noise: known?.noise,
				},
				{
					id: `${r.id}_p99_ms`,
					label: `${label}：p99`,
					value: r.p99Ms,
					unit: "ms",
					noise: known && known.noise * 2,
					...(known?.p99Target !== undefined && { check: target("<=", known.p99Target) }),
				},
			];
		});
		return { measurements };
	},
});
