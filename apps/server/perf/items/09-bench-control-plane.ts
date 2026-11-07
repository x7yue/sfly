// 基准测试：控制面的指标分段写入与降采样查询耗时（ARCHITECTURE §7.6；vitest bench）。
// 运行 perf/benchmarks/control-plane.bench.ts（也可以单独运行，见该文件），需要本机 PostgreSQL。只记录，不判定。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readVitestBench, runCommand } from "../bench.js";
import { definePerfItem, type ItemRun } from "../item.js";
import type { Measurement } from "../report.js";

/** 基准名 → 报告里的名称与平均值的正常波动（毫秒；p99 按两倍算）。 */
const BENCHES: Record<string, { label: string; noise: number }> = {
	segment_write: { label: "分段写入（120 秒 × 10 个指标，10 段整段写入）", noise: 2 },
	query_300: { label: "降采样查询（1 小时 × 10 个指标 → 300 个桶）", noise: 10 },
	query_12: { label: "降采样查询（1 小时 × 10 个指标 → 12 个桶，用段摘要）", noise: 5 },
};

export default definePerfItem({
	id: "bench-control-plane",
	title: "基准测试：控制面指标分段写入与降采样查询",
	scope: null,
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
				},
			];
		});
		return { measurements };
	},
});
