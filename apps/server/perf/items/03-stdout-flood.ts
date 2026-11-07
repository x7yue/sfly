// 负载：节点每秒向标准输出写 10 MiB（ARCHITECTURE §7.6「节点大量输出 stdout」）。
// 本机上 Agent 的转发跟得上这个速率，#75（转发跟不上时无界通道积压）在这里不会出现：这一项区分不出 #75 修复前后，
// 只是日志完整、副本有上限、内存有上限的回归检查；#75 的回归测试应在 Agent 单测里人为拖慢转发环节。
// 桩节点 stdout_rate 定速写出带序号的行；Agent 把每行转发给控制面，原始内容同时写到工作目录的 stdout.log
// （每个文件 8 MiB，超过后改名为 .1，最多两个文件）。
// 硬性断言：Agent 内存增量 ≤ 100 MB；控制面收到的 stdout 行按序号核对不丢不重、内容完整、日志没有被截断；
// 运行期间 stdout.log 副本最多两个文件、每个不超过 8 MiB、合计不超过 16 MiB。
// 只记录：节点实际写出速率、节点比计划落后的时间（Agent 背压时变大）、Agent CPU。

import { join } from "node:path";
import { checkLogCopies, type LogCopies } from "../checks.js";
import { listDirs, listFiles, sampleEvery } from "../disk.js";
import { definePerfItem, hard, type ItemRun, target } from "../item.js";
import { AGENT, MB, usageMeasurements } from "../measure.js";
import type { Measurement } from "../report.js";
import { sampleProcess, startStack } from "../stack.js";
import {
	checkStdoutLines,
	type StdoutLine,
	type StdoutOutputs,
	stdoutLine,
	stubScenario,
} from "../stub.js";
import { AGENT_RSS_GROWTH_MB, STDOUT_LOG_MAX_MIB, STDOUT_MIB_PER_SECOND } from "../targets.js";

/** 共 150 MiB：控制面单个任务的日志上限是 200 MiB（JSONL，每行约多 100 字节），留出余量。 */
const SECONDS = 15;
const LINE_BYTES = 1024;
const NODE_ID = "spew";
/** Agent 每个流的日志副本：最多两个文件、每个 8 MiB（agent/src/logs.rs 的 LogCopy），合计即 §7.6 的 16 MiB。 */
const LOG_COPY_MAX_FILES = 2;
const LOG_COPY_MAX_MIB = STDOUT_LOG_MAX_MIB / LOG_COPY_MAX_FILES;

export default definePerfItem({
	id: "stdout-flood",
	title: "节点每秒 10 MiB stdout",
	scope: "节点大量输出 stdout",
	needsArtifacts: true,
	async run(ctx): Promise<ItemRun> {
		const { agent, agentName, api } = await startStack(ctx);
		const scenario = await stubScenario(api, agentName, NODE_ID, "stdout_rate", {
			mib_per_second: STDOUT_MIB_PER_SECOND,
			seconds: SECONDS,
			line_bytes: LINE_BYTES,
		});

		// 采样所有任务目录里的 stdout.log 副本（只有这一个任务），记下最坏的一刻。
		const tasksDir = join(agent.workDir, "tasks");
		const copiesNow = async (): Promise<LogCopies> => {
			const worst: LogCopies = { files: 0, largestBytes: 0, totalBytes: 0 };
			for (const dir of await listDirs(tasksDir)) {
				const c = checkLogCopies(await listFiles(dir), "stdout.log");
				worst.files = Math.max(worst.files, c.files);
				worst.largestBytes = Math.max(worst.largestBytes, c.largestBytes);
				worst.totalBytes = Math.max(worst.totalBytes, c.totalBytes);
			}
			return worst;
		};
		const sampler = sampleProcess(agent.child.pid as number);
		const copies = sampleEvery(copiesNow, 100);
		ctx.log(`节点按每秒 ${STDOUT_MIB_PER_SECOND} MiB 写标准输出 ${SECONDS} 秒`);
		const runId = await api.trigger(scenario);
		const { attempt, outputs } = await api.succeeded<StdoutOutputs>(
			runId,
			NODE_ID,
			ctx.signal,
			(SECONDS + 120) * 1000,
		);
		const [agentUsage, copySamples] = await Promise.all([sampler.stop(), copies.stop()]);
		const usage = usageMeasurements(
			agentUsage,
			AGENT,
			{ rssMb: 2, cpuPercent: 5 },
			// §7.6 只要求「有上限」，借用单个 Agent 的 100 MB：断线时日志最多排队 64 MB（--log-queue-bytes），
			// 连着控制面时不该接近这个量。
			hard("<=", AGENT_RSS_GROWTH_MB),
		);

		const page = await api.waitLogsSettled(attempt.task_id, ctx.signal);
		const stdout: StdoutLine[] = [];
		await api.readTaskLogs(attempt.task_id, (l) => {
			if (l.source === "stdout") stdout.push(stdoutLine(l.text));
		});
		const lines = checkStdoutLines(stdout, outputs.lines, LINE_BYTES);
		const peak = (pick: (c: LogCopies) => number) =>
			Math.max(0, ...copySamples.map((s) => pick(s.value)));
		const final = copySamples.at(-1)?.value;

		const measurements: Measurement[] = [
			usage.growth,
			{
				id: "missing_lines",
				label: "丢失的 stdout 行（按行首序号核对）",
				value: lines.missing,
				unit: "行",
				check: hard("<=", 0),
			},
			{
				id: "duplicated_lines",
				label: "重复的 stdout 行",
				value: lines.duplicated,
				unit: "行",
				check: hard("<=", 0),
			},
			{
				id: "corrupted_lines",
				label: "序号或长度不对的 stdout 行",
				value: lines.unexpected + lines.malformed,
				unit: "行",
				check: hard("<=", 0),
			},
			{
				id: "log_truncated",
				label: "控制面日志被截断",
				value: page.truncated ? 1 : 0,
				unit: "",
				check: hard("<=", 0),
			},
			{
				id: "stdout_log_files",
				label: "stdout.log 副本文件数（运行期间最多）",
				value: peak((c) => c.files),
				unit: "个",
				check: hard("<=", LOG_COPY_MAX_FILES),
			},
			{
				id: "stdout_log_largest_mib",
				label: "stdout.log 单个副本最大",
				value: peak((c) => c.largestBytes) / MB,
				unit: "MiB",
				noise: 0.5,
				check: hard("<=", LOG_COPY_MAX_MIB),
			},
			{
				id: "stdout_log_total_mib",
				label: "stdout.log 副本合计（运行期间最多）",
				value: peak((c) => c.totalBytes) / MB,
				unit: "MiB",
				noise: 0.5,
				check: hard("<=", STDOUT_LOG_MAX_MIB),
			},
			{
				id: "stdout_rate_mib",
				label: "节点实际写出速率",
				value: outputs.bytes / MB / outputs.elapsed,
				unit: "MiB/秒",
				check: target(">=", STDOUT_MIB_PER_SECOND),
			},
			{
				id: "max_behind_ms",
				label: "节点比计划落后的最长时间",
				value: outputs.max_behind_ms,
				unit: "ms",
				noise: 20,
				check: target("<=", 1000),
			},
			usage.peak,
			usage.cpu,
		];
		return {
			measurements,
			series: [usage.series],
			notes: [
				`节点计划每秒写 ${STDOUT_MIB_PER_SECOND} MiB、共 ${SECONDS} 秒（每行 ${LINE_BYTES} 字节）；实际写出 ${outputs.lines} 行 / ${(outputs.bytes / MB).toFixed(0)} MiB，用时 ${outputs.elapsed.toFixed(2)} 秒。`,
				`控制面收到 ${stdout.length} 行 stdout（日志已写入的最大序号 ${page.last_seq}）；结束时 stdout.log 副本 ${final?.files ?? 0} 个、合计 ${((final?.totalBytes ?? 0) / MB).toFixed(1)} MiB，运行期间按 ${copySamples.length} 次采样取最坏值。`,
				"端到端的速率达不到让 #75（Agent 转发跟不上时无界通道积压）出现的程度：这一项区分不出 #75 修复前后，是日志完整、副本有上限、内存有上限的回归检查；#75 的回归测试应在 Agent 单测里人为拖慢转发环节。",
			],
		};
	},
});
