// 负载：节点每秒向标准输出写 10 MiB（ARCHITECTURE §7.6「节点大量输出 stdout」，也是 #75 的验收手段）。
// 桩节点 stdout_rate 定速写出带序号的行；Agent 把每行转发给控制面，原始内容同时写到工作目录的 stdout.log
// （每个文件 8 MiB，超过后改名为 .1，最多两个文件）。
// 硬性断言：Agent 内存增量 ≤ 100 MB；控制面收到的 stdout 行按序号核对不丢不重、内容完整、日志没有被截断；
// 运行期间 stdout.log 副本最多两个文件、每个不超过 8 MiB、合计不超过 16 MiB。
// 只记录：节点实际写出速率、节点比计划落后的时间（Agent 背压时变大）、Agent CPU。

import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { checkLogCopies, checkNumbered, type LogCopies } from "../checks.js";
import { listDirs, listFiles, sampleEvery } from "../disk.js";
import { definePerfItem, hard, type ItemRun, target } from "../item.js";
import type { Measurement } from "../report.js";
import { type PerfApi, sampleProcess, sleep, startStack } from "../stack.js";
import { AGENT_RSS_GROWTH_MB, STDOUT_LOG_MAX_MIB, STDOUT_MIB_PER_SECOND } from "../targets.js";

/** 共 150 MiB：控制面单个任务的日志上限是 200 MiB（JSONL，每行约多 100 字节），留出余量。 */
const SECONDS = 15;
const LINE_BYTES = 1024;
const MB = 1024 * 1024;
/** Agent 每个流的日志副本：最多两个文件、每个 8 MiB（agent/src/logs.rs 的 LogCopy），合计即 §7.6 的 16 MiB。 */
const LOG_COPY_MAX_FILES = 2;
const LOG_COPY_MAX_MIB = STDOUT_LOG_MAX_MIB / LOG_COPY_MAX_FILES;

interface StdoutOutputs {
	lines: number;
	bytes: number;
	elapsed: number;
	max_behind_ms: number;
}

/** 控制面里一个任务的 stdout 行：行首序号与长度不对的行数。 */
async function readStdoutLines(api: PerfApi, taskId: string) {
	const res = await api.request(`/tasks/${taskId}/logs/download`);
	const lines = createInterface({
		input: Readable.fromWeb(res.body as WebReadableStream<Uint8Array>),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	const numbers: number[] = [];
	let malformed = 0;
	for await (const raw of lines) {
		if (!raw) continue;
		const line = JSON.parse(raw) as { source: string; text: string };
		if (line.source !== "stdout") continue;
		numbers.push(Number(line.text.slice(0, line.text.indexOf(" "))));
		if (line.text.length !== LINE_BYTES - 1) malformed++;
	}
	return { numbers, malformed };
}

/** 等控制面写完这个任务的日志：已写入的最大序号 1 秒内不再变化（最多等 30 秒）。 */
async function waitLogSettled(api: PerfApi, taskId: string, signal: AbortSignal) {
	const deadline = Date.now() + 30_000;
	let last = -1;
	for (;;) {
		const page = (await api.getJson(`/tasks/${taskId}/logs?limit=1`)) as {
			last_seq: number;
			truncated: boolean;
		};
		if (page.last_seq === last || Date.now() > deadline) return page;
		last = page.last_seq;
		await sleep(1000, signal);
	}
}

export default definePerfItem({
	id: "stdout-flood",
	title: "节点每秒 10 MiB stdout",
	scope: "节点大量输出 stdout",
	needsArtifacts: true,
	async run(ctx): Promise<ItemRun> {
		const { agent, agentName, api } = await startStack(ctx);
		const orchestration = await api.createOrchestration({
			default_agent: agentName,
			nodes: [
				{ id: "entry", kind: "entry" },
				{
					id: "spew",
					kind: "package",
					package: "sfly-stub",
					node: "stdout_rate",
					inputs: {
						mib_per_second: STDOUT_MIB_PER_SECOND,
						seconds: SECONDS,
						line_bytes: LINE_BYTES,
					},
				},
			],
			edges: [{ from: "entry", to: "spew", kind: "chain" }],
			packages: { "sfly-stub": "0.1.0" },
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
		const usage = sampleProcess(agent.child.pid as number);
		const copies = sampleEvery(copiesNow, 100);
		ctx.log(`节点按每秒 ${STDOUT_MIB_PER_SECOND} MiB 写标准输出 ${SECONDS} 秒`);
		const runId = await api.trigger(orchestration);
		const view = await api.waitRun(runId, ctx.signal, (SECONDS + 120) * 1000);
		const [agentUsage, copySamples] = await Promise.all([usage.stop(), copies.stop()]);

		const attempt = view.chains[0]?.nodes.find((n) => n.node_id === "spew")?.attempts.at(-1);
		if (view.status !== "success" || !attempt?.outputs) {
			throw new Error(`运行没有成功（${view.status}）：${JSON.stringify(attempt?.error ?? null)}`);
		}
		const outputs = attempt.outputs as unknown as StdoutOutputs;
		const page = await waitLogSettled(api, attempt.task_id, ctx.signal);
		const received = await readStdoutLines(api, attempt.task_id);
		const lines = checkNumbered(received.numbers, outputs.lines);
		const peak = (pick: (c: LogCopies) => number) =>
			Math.max(0, ...copySamples.map((s) => pick(s.value)));
		const final = copySamples.at(-1)?.value;

		const measurements: Measurement[] = [
			{
				id: "agent_rss_growth_mb",
				label: "Agent 内存增量（峰值 - 开始）",
				value: (agentUsage.peakRssBytes - agentUsage.startRssBytes) / MB,
				unit: "MB",
				noise: 2,
				// §7.6 只要求「有上限」，借用单个 Agent 的 100 MB：断线时日志最多排队 64 MB（--log-queue-bytes），
				// 连着控制面时不该接近这个量。
				check: hard("<=", AGENT_RSS_GROWTH_MB),
			},
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
				value: lines.unexpected + received.malformed,
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
			{
				id: "agent_peak_rss_mb",
				label: "Agent 峰值内存（RSS）",
				value: agentUsage.peakRssBytes / MB,
				unit: "MB",
				noise: 2,
			},
			{
				id: "agent_cpu_percent",
				label: "Agent 平均 CPU（单核 = 100%）",
				value: agentUsage.cpuPercent,
				unit: "%",
				noise: 5,
			},
		];
		return {
			measurements,
			series: [
				{
					id: "agent_rss",
					label: "Agent 内存（RSS）",
					unit: "MB",
					points: agentUsage.samples.map((p) => [p.ms, p.rssBytes / MB]),
				},
			],
			notes: [
				`节点计划每秒写 ${STDOUT_MIB_PER_SECOND} MiB、共 ${SECONDS} 秒（每行 ${LINE_BYTES} 字节）；实际写出 ${outputs.lines} 行 / ${(outputs.bytes / MB).toFixed(0)} MiB，用时 ${outputs.elapsed.toFixed(2)} 秒。`,
				`控制面收到 ${received.numbers.length} 行 stdout（日志已写入的最大序号 ${page.last_seq}）；结束时 stdout.log 副本 ${final?.files ?? 0} 个、合计 ${((final?.totalBytes ?? 0) / MB).toFixed(1)} MiB，运行期间按 ${copySamples.length} 次采样取最坏值。`,
			],
		};
	},
});
