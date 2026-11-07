// 负载：任务持续上报期间 Agent 与控制面断线（ARCHITECTURE §7.6「Agent 断线」）。
// 两个任务同时运行：桩节点 metric_rate 每秒上报 1 万次指标，stdout_rate 每秒写 3 MiB 带序号的 stdout。
// 连着控制面上报几秒后停掉打包后的控制面，断线一段时间（pnpm perf 里默认 45 秒；SFLY_PERF_DISCONNECT_SECONDS=300 跑满 5 分钟），
// 再用同一个数据库、数据目录和端口重启，Agent 按原地址重连、补发排队的日志和指标，任务照常跑完。
//
// Agent 断线期间日志最多排队 64 MiB（超出后丢弃新的日志批次，控制面看到序号缺口），指标最多排队一定点数
// （超出后丢弃最早的点，随下一批上报丢弃数）。一个真实任务每个指标每秒只合并出一个点，断线 5 分钟也远到不了
// 默认的 50 万点，所以这里把指标排队上限调小（SFLY_METRIC_QUEUE_POINTS），让丢弃与计数真正发生。
//
// 硬性断言：断线期间 Agent 内存增量不超过日志排队上限加余量；重连后补发了断线期间排队的日志与指标；
// 丢弃的 stdout 行数与控制面看到的序号缺口一致、丢失的整秒指标点数与控制面记录的丢弃数一致；没有重复、损坏、截断。
// 只记录：断线期间的内存曲线、重连耗时、补发耗时、丢弃数量。
import { startBundledServer } from "../../test/support/bundled-server.js";
import { checkNumbered, windowGrowth } from "../checks.js";
import { disconnectSeconds, missingSeconds, replayDuration } from "../disconnect.js";
import { sampleEvery } from "../disk.js";
import { definePerfItem, hard, type ItemRun, type PerfItem } from "../item.js";
import { AGENT, MB, usageMeasurements } from "../measure.js";
import type { Measurement } from "../report.js";
import { type PerfApi, sampleProcess, sleep, startStack } from "../stack.js";
import {
	checkSeqMetric,
	checkStdoutLines,
	type RateOutputs,
	type StdoutLine,
	type StdoutOutputs,
	stdoutLine,
	stubScenario,
} from "../stub.js";
import { EVENTS_PER_SECOND } from "../targets.js";

const STDOUT_MIB_PER_SECOND = 3;
const LINE_BYTES = 1024;
/** Agent 断线期间最多排队的日志字节数（agent/src/logs.rs 的 DEFAULT_TELEMETRY_QUEUE_BYTES，这里用默认值）。 */
const LOG_QUEUE_BYTES = 64 * MB;
/** 断线期间最多排队的指标点数（调小，见文件开头）。 */
const METRIC_QUEUE_POINTS = 10;
/** 断线期间内存增量的上限：排队的日志编码后最多 64 MiB，内存里的结构体与分配器开销按一半余量算。 */
const RSS_GROWTH_LIMIT_MB = 96;
/** 两个任务都开始执行后，连着控制面上报这么久再断线。 */
const CONNECTED_SECONDS = 5;
/**
 * 节点在「连着 + 断线」之外多跑这么久：控制面重启（几秒）、Agent 重连退避（最长 10 秒）之后还要在线跑一会儿，
 * 补发完才有重连后产生的日志可比。日志总量（断线前 + 排队 64 MiB + 重连后）要留在控制面单任务 200 MiB 上限以内。
 */
const EXTRA_SECONDS = 25;
const METRIC_NODE = "events";
const STDOUT_NODE = "spew";

/** 控制面收到的一行日志（不留正文：十几万行）。 */
interface ReceivedLine {
	seq: number;
	timeMs: number;
	/** 正文的长度（不含换行）。 */
	length: number;
	/** stdout 行的序号与长度；其他来源（Agent、系统）为 null。 */
	stdout: StdoutLine | null;
}

async function receivedLines(api: PerfApi, taskId: string): Promise<ReceivedLine[]> {
	const lines: ReceivedLine[] = [];
	await api.readTaskLogs(taskId, (l) => {
		lines.push({
			seq: l.seq,
			timeMs: l.timeMs,
			length: l.text.length,
			stdout: l.source === "stdout" ? stdoutLine(l.text) : null,
		});
	});
	return lines;
}

/** 等两个运行里的节点都开始执行，返回各自的任务 ID。 */
async function waitRunning(
	api: PerfApi,
	runs: Array<{ runId: string; nodeId: string }>,
	signal: AbortSignal,
): Promise<string[]> {
	const deadline = Date.now() + 120_000;
	for (;;) {
		const attempts = await Promise.all(runs.map(({ runId, nodeId }) => api.attempt(runId, nodeId)));
		if (attempts.every((a) => a?.status === "running")) {
			return attempts.map((a) => a?.task_id as string);
		}
		if (Date.now() > deadline) throw new Error("两个任务在 120 秒内没有都开始执行");
		await sleep(200, signal);
	}
}

const welcomes = (events: ReadonlyArray<Record<string, unknown>>) =>
	events.filter((e) => e.event === "welcome").length;

/**
 * Agent 断线这一项；`seconds` 是控制面停掉的时长，不给时读环境变量 SFLY_PERF_DISCONNECT_SECONDS（运行时读取），
 * 默认 45 秒（perf:soak 可以设成 300，即 ARCHITECTURE §7.6 的 5 分钟）。
 */
export function agentDisconnect(seconds?: number): PerfItem {
	return definePerfItem({
		id: "agent-disconnect",
		title: "Agent 断线",
		scope: "Agent 断线",
		needsArtifacts: true,
		async run(ctx): Promise<ItemRun> {
			const downSeconds = disconnectSeconds(seconds, process.env);
			const nodeSeconds = CONNECTED_SECONDS + downSeconds + EXTRA_SECONDS;
			const stack = await startStack(ctx, {
				agentEnv: { SFLY_METRIC_QUEUE_POINTS: String(METRIC_QUEUE_POINTS) },
			});
			const { agent, agentName, api, database } = stack;
			const metricScenario = await stubScenario(
				api,
				agentName,
				METRIC_NODE,
				"metric_rate",
				{ rate: EVENTS_PER_SECOND, seconds: nodeSeconds },
				METRIC_NODE,
			);
			const stdoutScenario = await stubScenario(
				api,
				agentName,
				STDOUT_NODE,
				"stdout_rate",
				{ mib_per_second: STDOUT_MIB_PER_SECOND, seconds: nodeSeconds, line_bytes: LINE_BYTES },
				STDOUT_NODE,
			);

			const sampledFrom = Date.now();
			const sampler = sampleProcess(agent.child.pid as number);
			ctx.log(
				`控制面停掉 ${downSeconds} 秒；两个任务各跑 ${nodeSeconds} 秒：每秒 ${EVENTS_PER_SECOND} 次指标、每秒 ${STDOUT_MIB_PER_SECOND} MiB stdout`,
			);
			const metricRun = await api.trigger(metricScenario);
			const stdoutRun = await api.trigger(stdoutScenario);
			const tasks = await waitRunning(
				api,
				[
					{ runId: metricRun, nodeId: METRIC_NODE },
					{ runId: stdoutRun, nodeId: STDOUT_NODE },
				],
				ctx.signal,
			);
			const stdoutTask = tasks[1] as string;
			await sleep(CONNECTED_SECONDS * 1000, ctx.signal);

			const http = Number(new URL(stack.server.httpUrl).port);
			const grpc = Number(new URL(stack.server.grpcUrl).port);
			ctx.log(`停掉控制面 ${downSeconds} 秒`);
			const stopAt = Date.now();
			await stack.server.stop();
			await sleep(downSeconds * 1000, ctx.signal);

			const welcomed = welcomes(agent.events);
			const server = await startBundledServer({
				dir: ctx.artifacts.bundleDir,
				databaseUrl: database.url,
				dataDir: stack.dataDir,
				ports: { http, grpc },
			});
			ctx.defer(() => server.stop());
			const restartAt = Date.now();
			// 控制面已写入的日志最大序号：补发耗时从这里算。
			const progress = sampleEvery(async () => (await api.logPage(stdoutTask)).last_seq, 200);
			ctx.log("控制面已重启，等 Agent 重连");
			const reconnectDeadline = Date.now() + 60_000;
			while (welcomes(agent.events) <= welcomed) {
				if (Date.now() > reconnectDeadline) throw new Error("Agent 在 60 秒内没有重新连上控制面");
				await sleep(50, ctx.signal);
			}
			const welcomeAt = Date.now();

			const timeoutMs = (nodeSeconds + 120) * 1000;
			const [metricTask, stdoutTaskResult] = await Promise.all([
				api.succeeded<RateOutputs>(metricRun, METRIC_NODE, ctx.signal, timeoutMs),
				api.succeeded<StdoutOutputs>(stdoutRun, STDOUT_NODE, ctx.signal, timeoutMs),
			]);
			const agentUsage = await sampler.stop();

			// 日志：补发、丢弃与控制面看到的序号缺口。
			const page = await api.waitLogsSettled(stdoutTask, ctx.signal);
			const progressSamples = await progress.stop();
			const stdoutOutputs = stdoutTaskResult.outputs;
			const lines = await receivedLines(api, stdoutTask);
			const stdout = lines.flatMap((l) => (l.stdout ? [l.stdout] : []));
			const numbered = checkStdoutLines(stdout, stdoutOutputs.lines, LINE_BYTES);
			// 十几万行：不能展开成 Math.max 的参数（调用栈放不下）。
			const maxSeq = lines.reduce((m, l) => Math.max(m, l.seq), 0);
			const seqGaps = checkNumbered(
				lines.map((l) => l.seq),
				maxSeq,
			);
			const replayedLog = lines.filter((l) => l.timeMs >= stopAt && l.timeMs < welcomeAt);
			const replayedLogBytes = replayedLog.reduce((n, l) => n + l.length + 1, 0);
			const replayMs = replayDuration(
				progressSamples.map((s) => ({ ms: s.ms, lastSeq: s.value })),
				lines,
				welcomeAt,
			);
			if (replayMs === null)
				throw new Error("日志写完之前没有看到补发完成（进度采样里序号没有追上）");

			// 指标：等最后一个点写进控制面，再核对整秒丢失的点数与控制面记录的丢弃数。
			const seq = await checkSeqMetric(
				api,
				{ runId: metricRun, nodeId: METRIC_NODE, ...metricTask },
				metricTask.outputs.count,
				ctx.signal,
			);
			const { buckets, droppedPoints } = seq;
			const bucketTimes = buckets.map((b) => Date.parse(b.time));
			const lostSeconds = missingSeconds(bucketTimes);
			const replayedPoints = bucketTimes.filter((t) => t >= stopAt && t < welcomeAt).length;

			// 内存：断线期间（停掉控制面到重新连上）相对断线那一刻的增长。
			const rss = agentUsage.samples.map((s) => ({ ms: sampledFrom + s.ms, bytes: s.rssBytes }));
			const growth = windowGrowth(rss, stopAt, welcomeAt);
			if (!growth) throw new Error("断线期间没有采到 Agent 内存");
			const usage = usageMeasurements(agentUsage, AGENT, { rssMb: 4, cpuPercent: 5 });

			const measurements: Measurement[] = [
				{
					id: "agent_rss_growth_mb",
					label: "断线期间 Agent 内存增量（峰值 - 断线时）",
					value: growth.growthBytes / MB,
					unit: "MB",
					noise: 4,
					check: hard("<=", RSS_GROWTH_LIMIT_MB),
				},
				{
					id: "replayed_log_mib",
					label: "重连后补发的断线期间日志",
					value: replayedLogBytes / MB,
					unit: "MiB",
					noise: 2,
					// 断线期间产生的日志远超排队上限：应当排满（编码后 64 MiB，正文略少）并在重连后全部补发。
					check: hard(">=", (LOG_QUEUE_BYTES / MB) * 0.9),
				},
				{
					id: "log_queue_excess_mib",
					label: "补发的断线期间日志超出排队上限的部分",
					value: Math.max(0, replayedLogBytes - LOG_QUEUE_BYTES) / MB,
					unit: "MiB",
					check: hard("<=", 0),
				},
				{
					id: "dropped_log_lines",
					label: "断线排队超过上限丢弃的 stdout 行",
					value: numbered.missing,
					unit: "行",
					noise: 10_000,
					// 断线时长让日志排满之后还要再产生一些：一行都没丢说明没有测到丢弃。
					check: hard(">=", 1),
				},
				{
					id: "dropped_log_mismatch",
					label: "丢弃的 stdout 行与控制面看到的序号缺口之差",
					value: Math.abs(numbered.missing - seqGaps.missing),
					unit: "行",
					check: hard("<=", 0),
				},
				{
					id: "corrupted_log_lines",
					label: "重复、序号或长度不对的 stdout 行",
					value:
						numbered.duplicated + numbered.unexpected + numbered.malformed + seqGaps.duplicated,
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
					id: "replayed_metric_points",
					label: "重连后补发的断线期间指标点",
					value: replayedPoints,
					unit: "个",
					noise: 3,
					// 排队里最新的 METRIC_QUEUE_POINTS 个点都应当补发过来（另有重连前还没发出的一两秒）。
					check: hard(">=", METRIC_QUEUE_POINTS),
				},
				{
					id: "dropped_metric_points",
					label: "断线排队超过上限丢弃的指标点（控制面记录）",
					value: droppedPoints,
					unit: "个",
					noise: 15,
					check: hard(">=", 1),
				},
				{
					id: "dropped_metric_mismatch",
					label: "整秒丢失的指标点与控制面记录的丢弃数之差",
					value: Math.abs(lostSeconds - droppedPoints),
					unit: "个",
					check: hard("<=", 0),
				},
				{
					id: "duplicated_metric",
					label: "重复的事件与同一秒多出的指标点",
					value: seq.sequence.duplicated + seq.duplicatePoints,
					unit: "个",
					check: hard("<=", 0),
				},
				{
					id: "metric_truncated",
					label: "指标数据被截断",
					value: seq.truncated ? 1 : 0,
					unit: "",
					check: hard("<=", 0),
				},
				{
					id: "reconnect_ms",
					label: "控制面重启后 Agent 重新连上的耗时",
					value: welcomeAt - restartAt,
					unit: "ms",
					// 重连退避最长 10 秒，取决于断线时正好退避到哪一步。
					noise: 10_000,
				},
				{
					id: "replay_ms",
					label: "重连后补发完排队日志的耗时",
					value: replayMs,
					unit: "ms",
					noise: 1000,
				},
				usage.peak,
			];
			const offset = (ms: number) => ((ms - sampledFrom) / 1000).toFixed(1);
			return {
				measurements,
				series: [
					usage.series,
					{
						id: "log_last_seq",
						label: "控制面已写入的 stdout 任务日志最大序号（重启后）",
						unit: "",
						points: progressSamples.map((s) => [s.ms - sampledFrom, s.value]),
					},
				],
				notes: [
					`控制面停掉 ${downSeconds} 秒；两个任务各跑 ${nodeSeconds} 秒：每秒 ${EVENTS_PER_SECOND} 次指标、每秒 ${STDOUT_MIB_PER_SECOND} MiB stdout（每行 ${LINE_BYTES} 字节）。` +
						`日志排队上限用 Agent 默认的 ${LOG_QUEUE_BYTES / MB} MiB，指标排队上限调成 ${METRIC_QUEUE_POINTS} 个点（默认 50 万点，一个任务断线 5 分钟也排不满）。`,
					`时间线（相对采样开始，秒）：${offset(stopAt)} 停掉控制面，${offset(restartAt)} 重启，${offset(welcomeAt)} Agent 重新连上；` +
						`断线期间内存从 ${(growth.baselineBytes / MB).toFixed(1)} MB 涨到峰值 ${(growth.peakBytes / MB).toFixed(1)} MB。`,
					`日志：节点写出 ${stdoutOutputs.lines} 行，控制面收到 ${stdout.length} 行 stdout（最大序号 ${maxSeq}），` +
						`其中断线期间产生、重连后补发的 ${replayedLog.length} 行；丢弃 ${numbered.missing} 行，序号缺口 ${seqGaps.missing} 个。`,
					`指标：控制面收到 ${buckets.length} 秒的点，断线期间的 ${replayedPoints} 个；整秒丢失 ${lostSeconds} 个，控制面记录丢弃 ${droppedPoints} 个。`,
				],
			};
		},
	});
}

export default agentDisconnect();
