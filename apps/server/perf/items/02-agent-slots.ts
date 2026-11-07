// 负载：一台 Agent 的 4 个槽位同时以每秒 1 万次事件上报（ARCHITECTURE §7.6「单个 Agent」）。
// 同一个场景触发 4 次，每次一个桩节点 metric_rate 任务（定速上报 seq = 1, 2, …），Agent 以 --slots 4 同时执行。
// 硬性断言：Agent 内存增量 ≤ 100 MB；所有任务都开始之后到第一个任务结束，工作目录占用不增长（事件不落盘，
// ADR 0015）；4 个任务的事件按序号核对不丢不重、Agent 没有丢弃点、数据没有被截断；4 个任务确实同时在执行。
// 只记录：各任务的实际速率、节点比计划落后的时间、单次 ctx.metric() 最长耗时、Agent CPU。
import { join } from "node:path";
import { checkSequence, windowGrowth } from "../checks.js";
import { dirUsage, sampleEvery } from "../disk.js";
import { definePerfItem, hard, type ItemRun, target } from "../item.js";
import type { Measurement } from "../report.js";
import { type PerfApi, sampleProcess, sleep, startStack } from "../stack.js";
import { AGENT_RSS_GROWTH_MB, AGENT_SLOTS, EVENTS_PER_SECOND } from "../targets.js";

const SECONDS = 30;
const MB = 1024 * 1024;
/** 窗口从最后一个任务开始后这么久算起：执行器刚启动时 Python 导入、创建文件的那一下不算增长。 */
const SETTLE_MS = 2000;

interface RateOutputs {
	count: number;
	elapsed: number;
	max_behind_ms: number;
	max_call_ms: number;
}

/** 一个任务的核对结果。 */
interface TaskResult {
	outputs: RateOutputs;
	startedMs: number;
	endedMs: number;
	missing: number;
	duplicated: number;
	duplicatePoints: number;
	droppedPoints: number;
	truncated: boolean;
}

/** 等运行结束、最后一个点写进控制面，再按序号核对这个任务的 seq 序列。 */
async function checkRun(api: PerfApi, runId: string, signal: AbortSignal): Promise<TaskResult> {
	const view = await api.waitRun(runId, signal, (SECONDS + 120) * 1000);
	const attempt = view.chains[0]?.nodes.find((n) => n.node_id === "events")?.attempts.at(-1);
	if (view.status !== "success" || !attempt?.outputs || !attempt.started_at || !attempt.ended_at) {
		throw new Error(`运行没有成功（${view.status}）：${JSON.stringify(attempt?.error ?? null)}`);
	}
	const outputs = attempt.outputs as unknown as RateOutputs;
	const deadline = Date.now() + 20_000;
	let catalogAttempt:
		| Awaited<ReturnType<typeof api.metricCatalog>>["nodes"][number]["attempts"][number]
		| undefined;
	for (;;) {
		const catalog = await api.metricCatalog(runId);
		catalogAttempt = catalog.nodes.find((n) => n.node_id === "events")?.attempts.at(-1);
		const seq = catalogAttempt?.metrics.find((m) => m.name === "seq");
		if (seq?.last === outputs.count || Date.now() > deadline) break;
		await sleep(500, signal);
	}
	const series = await api.metricSeries(runId, view.chains[0]?.id as string, "events");
	const buckets = series.series.find((s) => s.name === "seq")?.buckets ?? [];
	if (buckets.length > 0 && series.bucket_seconds !== 1) {
		throw new Error(`序列不是每秒一个桶（${series.bucket_seconds} 秒）`);
	}
	const writtenPoints = catalogAttempt?.metrics.find((m) => m.name === "seq")?.points ?? 0;
	const sequence = checkSequence(buckets, outputs.count);
	return {
		outputs,
		startedMs: Date.parse(attempt.started_at),
		endedMs: Date.parse(attempt.ended_at),
		missing: sequence.missing,
		duplicated: sequence.duplicated,
		duplicatePoints: Math.max(sequence.duplicatePoints, writtenPoints - buckets.length),
		droppedPoints: catalogAttempt?.dropped_points ?? 0,
		truncated: catalogAttempt?.truncated ?? false,
	};
}

export default definePerfItem({
	id: "agent-slots",
	title: "单 Agent 4 槽位同时每秒 1 万次事件",
	scope: "单个 Agent",
	needsArtifacts: true,
	async run(ctx): Promise<ItemRun> {
		const { agent, agentName, api } = await startStack(ctx, {
			agentArgs: ["--slots", String(AGENT_SLOTS)],
		});
		const orchestration = await api.createOrchestration({
			default_agent: agentName,
			nodes: [
				{ id: "entry", kind: "entry" },
				{
					id: "events",
					kind: "package",
					package: "sfly-stub",
					node: "metric_rate",
					inputs: { rate: EVENTS_PER_SECOND, seconds: SECONDS },
				},
			],
			edges: [{ from: "entry", to: "events", kind: "chain" }],
			packages: { "sfly-stub": "0.1.0" },
		});

		const tasksDir = join(agent.workDir, "tasks");
		const usage = sampleProcess(agent.child.pid as number);
		const disk = sampleEvery(() => dirUsage(tasksDir), 500);
		ctx.log(`${AGENT_SLOTS} 个任务同时按每秒 ${EVENTS_PER_SECOND} 次上报 ${SECONDS} 秒`);
		const runIds: string[] = [];
		for (let i = 0; i < AGENT_SLOTS; i++) runIds.push(await api.trigger(orchestration));
		const tasks = await Promise.all(runIds.map((id) => checkRun(api, id, ctx.signal)));
		const [agentUsage, diskSamples] = await Promise.all([usage.stop(), disk.stop()]);

		const lastStart = Math.max(...tasks.map((t) => t.startedMs));
		const firstEnd = Math.min(...tasks.map((t) => t.endedMs));
		const growth = windowGrowth(
			diskSamples.map((s) => ({ ms: s.ms, bytes: s.value })),
			lastStart + SETTLE_MS,
			firstEnd,
		);
		if (!growth) throw new Error("4 个任务同时执行的时间里没有采到工作目录占用");
		const sum = (pick: (t: TaskResult) => number) => tasks.reduce((n, t) => n + pick(t), 0);
		const max = (pick: (t: TaskResult) => number) => Math.max(...tasks.map(pick));
		const min = (pick: (t: TaskResult) => number) => Math.min(...tasks.map(pick));

		const measurements: Measurement[] = [
			{
				id: "agent_rss_growth_mb",
				label: "Agent 内存增量（峰值 - 开始）",
				value: (agentUsage.peakRssBytes - agentUsage.startRssBytes) / MB,
				unit: "MB",
				noise: 2,
				check: hard("<=", AGENT_RSS_GROWTH_MB),
			},
			{
				id: "work_dir_growth_mb",
				label: "工作目录占用增长（所有任务开始后到第一个任务结束）",
				value: growth.growthBytes / MB,
				unit: "MB",
				noise: 0.1,
				// 事件走 FIFO 不落盘，节点也不写别的文件：块对齐的小波动之外应当不涨；
				// 事件若落盘（#69），4 个任务每秒约 2 MB，远超这个值。
				check: hard("<=", 1),
			},
			{
				id: "concurrent_seconds",
				label: `${AGENT_SLOTS} 个任务同时执行的时长`,
				value: (firstEnd - lastStart) / 1000,
				unit: "秒",
				noise: 2,
				check: hard(">=", SECONDS / 2),
			},
			{
				id: "missing_events",
				label: "丢失的事件（按序号核对，4 个任务合计）",
				value: sum((t) => t.missing),
				unit: "个",
				check: hard("<=", 0),
			},
			{
				id: "duplicated_events",
				label: "重复的事件（按序号核对，4 个任务合计）",
				value: sum((t) => t.duplicated),
				unit: "个",
				check: hard("<=", 0),
			},
			{
				id: "duplicate_points",
				label: "同一秒多出的指标点（4 个任务合计）",
				value: sum((t) => t.duplicatePoints),
				unit: "个",
				check: hard("<=", 0),
			},
			{
				id: "dropped_points",
				label: "Agent 丢弃的指标点（4 个任务合计）",
				value: sum((t) => t.droppedPoints),
				unit: "个",
				check: hard("<=", 0),
			},
			{
				id: "truncated",
				label: "指标数据被截断的任务",
				value: sum((t) => (t.truncated ? 1 : 0)),
				unit: "个",
				check: hard("<=", 0),
			},
			{
				id: "min_event_rate",
				label: "最慢任务的实际上报速率",
				value: min((t) => t.outputs.count / t.outputs.elapsed),
				unit: "次/秒",
				check: target(">=", EVENTS_PER_SECOND),
			},
			{
				id: "max_behind_ms",
				label: "节点比计划落后的最长时间（所有任务）",
				value: max((t) => t.outputs.max_behind_ms),
				unit: "ms",
				noise: 5,
				check: target("<=", 1000),
			},
			{
				id: "max_call_ms",
				label: "单次 ctx.metric() 最长耗时（所有任务）",
				value: max((t) => t.outputs.max_call_ms),
				unit: "ms",
				noise: 5,
			},
			{
				id: "agent_peak_rss_mb",
				label: "Agent 峰值内存（RSS）",
				value: agentUsage.peakRssBytes / MB,
				unit: "MB",
				noise: 2,
			},
			{
				id: "work_dir_peak_mb",
				label: "工作目录峰值占用",
				value: Math.max(...diskSamples.map((s) => s.value)) / MB,
				unit: "MB",
				noise: 0.1,
			},
			{
				id: "agent_cpu_percent",
				label: "Agent 平均 CPU（单核 = 100%）",
				value: agentUsage.cpuPercent,
				unit: "%",
				noise: 3,
			},
		];
		const diskStart = diskSamples[0]?.ms ?? 0;
		return {
			measurements,
			series: [
				{
					id: "agent_rss",
					label: "Agent 内存（RSS）",
					unit: "MB",
					points: agentUsage.samples.map((p) => [p.ms, p.rssBytes / MB]),
				},
				{
					id: "work_dir",
					label: "工作目录占用",
					unit: "MB",
					points: diskSamples.map((s) => [s.ms - diskStart, s.value / MB]),
				},
			],
			notes: [
				`${AGENT_SLOTS} 个任务各计划每秒上报 ${EVENTS_PER_SECOND} 次、共 ${SECONDS} 秒；实际 ${tasks
					.map((t) => `${t.outputs.count} 次 / ${t.outputs.elapsed.toFixed(2)} 秒`)
					.join("、")}。`,
				`工作目录占用按 ${diskSamples.length} 次采样（每 0.5 秒）计算，窗口内基准 ${(growth.baselineBytes / 1024).toFixed(0)} KiB、峰值 ${(growth.peakBytes / 1024).toFixed(0)} KiB。`,
			],
		};
	},
});
