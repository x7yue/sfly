// 负载：一台 Agent 的 4 个槽位同时以每秒 1 万次事件上报（ARCHITECTURE §7.6「单个 Agent」）。
// 同一个场景触发 4 次，每次一个桩节点 metric_rate 任务（定速上报 seq = 1, 2, …），Agent 以 --slots 4 同时执行。
// 硬性断言：Agent 内存增量 ≤ 100 MB；所有任务都开始之后到第一个任务结束，工作目录占用不增长（事件不落盘，
// ADR 0015）；4 个任务的事件按序号核对不丢不重、Agent 没有丢弃点、数据没有被截断；4 个任务确实同时在执行。
// 只记录：各任务的实际速率、节点比计划落后的时间、单次 ctx.metric() 最长耗时、Agent CPU。
import { join } from "node:path";
import { windowGrowth } from "../checks.js";
import { dirUsage, sampleEvery } from "../disk.js";
import { definePerfItem, hard, type ItemRun, target } from "../item.js";
import { AGENT, MB, usageMeasurements } from "../measure.js";
import type { Measurement } from "../report.js";
import { type PerfApi, sampleProcess, startStack } from "../stack.js";
import { checkSeqMetric, type RateOutputs, stubScenario } from "../stub.js";
import { AGENT_RSS_GROWTH_MB, AGENT_SLOTS, EVENTS_PER_SECOND } from "../targets.js";

const SECONDS = 30;
const NODE_ID = "events";
/** 窗口从最后一个任务开始后这么久算起：执行器刚启动时 Python 导入、创建文件的那一下不算增长。 */
const SETTLE_MS = 2000;

/** 等运行结束、最后一个点写进控制面，再按序号核对这个任务的 seq 序列。 */
async function checkRun(api: PerfApi, runId: string, signal: AbortSignal) {
	const task = await api.succeeded<RateOutputs>(runId, NODE_ID, signal, (SECONDS + 120) * 1000);
	const seq = await checkSeqMetric(
		api,
		{ runId, nodeId: NODE_ID, ...task },
		task.outputs.count,
		signal,
	);
	return { ...task, ...seq };
}

type TaskResult = Awaited<ReturnType<typeof checkRun>>;

export default definePerfItem({
	id: "agent-slots",
	title: "单 Agent 4 槽位同时每秒 1 万次事件",
	scope: "单个 Agent",
	needsArtifacts: true,
	async run(ctx): Promise<ItemRun> {
		const { agent, agentName, api } = await startStack(ctx, {
			agentArgs: ["--slots", String(AGENT_SLOTS)],
		});
		const scenario = await stubScenario(api, agentName, NODE_ID, "metric_rate", {
			rate: EVENTS_PER_SECOND,
			seconds: SECONDS,
		});

		const tasksDir = join(agent.workDir, "tasks");
		const sampler = sampleProcess(agent.child.pid as number);
		const disk = sampleEvery(() => dirUsage(tasksDir), 500);
		ctx.log(`${AGENT_SLOTS} 个任务同时按每秒 ${EVENTS_PER_SECOND} 次上报 ${SECONDS} 秒`);
		const runIds: string[] = [];
		for (let i = 0; i < AGENT_SLOTS; i++) runIds.push(await api.trigger(scenario));
		const tasks = await Promise.all(runIds.map((id) => checkRun(api, id, ctx.signal)));
		const [agentUsage, diskSamples] = await Promise.all([sampler.stop(), disk.stop()]);
		const usage = usageMeasurements(
			agentUsage,
			AGENT,
			{ rssMb: 2, cpuPercent: 3 },
			hard("<=", AGENT_RSS_GROWTH_MB),
		);

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
			usage.growth,
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
				value: sum((t) => t.sequence.missing),
				unit: "个",
				check: hard("<=", 0),
			},
			{
				id: "duplicated_events",
				label: "重复的事件（按序号核对，4 个任务合计）",
				value: sum((t) => t.sequence.duplicated),
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
			usage.peak,
			{
				id: "work_dir_peak_mb",
				label: "工作目录峰值占用",
				value: Math.max(...diskSamples.map((s) => s.value)) / MB,
				unit: "MB",
				noise: 0.1,
			},
			usage.cpu,
		];
		const diskStart = diskSamples[0]?.ms ?? 0;
		return {
			measurements,
			series: [
				usage.series,
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
