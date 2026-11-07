// 基准测试：Agent 的指标合并与按行切分吞吐（ARCHITECTURE §7.6；criterion，只作开发依赖，不进 release 构建）。
// 运行 `cargo bench -p sfly-agent --bench telemetry`（也可以单独运行，见 agent/benches/telemetry.rs），
// 结果写到这一项的临时目录（CRITERION_HOME），不影响 target/criterion 里自己跑的结果。只记录，不判定。
import { join } from "node:path";
import { readCriterion } from "../bench.js";
import { runChecked } from "../command.js";
import { definePerfItem, type ItemRun } from "../item.js";
import { MB } from "../measure.js";
import type { Measurement } from "../report.js";

/** criterion 的函数名 → 报告里的名称。 */
const LABELS: Record<string, string> = {
	merge_events: "指标合并吞吐（1 秒内 1 万次上报，4 个指标）",
	split_short_lines: "按行切分吞吐（80 字节的短行）",
	split_long_lines: "按行切分吞吐（没有换行，按 64 KiB 拆开）",
};

export default definePerfItem({
	id: "bench-agent",
	title: "基准测试：Agent 指标合并与按行切分",
	scope: null,
	needsArtifacts: false,
	async run(ctx): Promise<ItemRun> {
		const home = join(ctx.tmpDir, "criterion");
		ctx.log("cargo bench（首次需要编译，较慢）");
		await runChecked(
			"cargo",
			["bench", "--locked", "-p", "sfly-agent", "--bench", "telemetry", "--", "--noplot"],
			{ cwd: ctx.repoRoot, signal: ctx.signal, env: { ...process.env, CRITERION_HOME: home } },
		);
		const results = await readCriterion(home);
		if (results.length === 0) throw new Error(`${home} 里没有 criterion 的结果`);
		const measurements: Measurement[] = results.map((r) => {
			const label = LABELS[r.id] ?? r.id;
			if (r.unit === "bytes") {
				return { id: r.id, label, value: (r.perSecond as number) / MB, unit: "MB/s" };
			}
			if (r.unit === "elements") {
				return { id: r.id, label, value: (r.perSecond as number) / 1e6, unit: "百万次/秒" };
			}
			return { id: r.id, label, value: r.meanNs / 1000, unit: "µs" };
		});
		return {
			measurements,
			notes: [
				"criterion 的平均值；按行切分每次处理 1 MiB，按 16 KiB 一块喂入（与读取管道时相同）。",
			],
		};
	},
});
