// 负载：单个任务以每秒 1 万次事件持续上报（ARCHITECTURE §7.6「单个任务 SDK → Agent」）。
// 桩节点 metric_rate 按定速上报 seq = 1, 2, …（ctx.metric 写 FIFO，ADR 0015），Agent 按秒合并后转发给控制面。
// 硬性断言：事件按序号核对不丢不重、每秒一个点、Agent 没有丢弃点、数据没有被截断。
// 只记录：实际速率与节点比计划落后的时间（节点是否被阻塞）、单次 ctx.metric() 最长耗时、Agent 内存与 CPU。
import { definePerfItem, hard, type ItemRun, target } from "../item.js";
import { AGENT, usageMeasurements } from "../measure.js";
import type { Measurement } from "../report.js";
import { sampleProcess, startStack } from "../stack.js";
import { checkSeqMetric, type RateOutputs, stubScenario } from "../stub.js";
import { EVENTS_PER_SECOND } from "../targets.js";

const SECONDS = 30;
const NODE_ID = "events";

export default definePerfItem({
	id: "single-task-events",
	title: "单任务每秒 1 万次事件",
	scope: "单个任务 SDK → Agent",
	needsArtifacts: true,
	async run(ctx): Promise<ItemRun> {
		const { agent, agentName, api } = await startStack(ctx);
		const scenario = await stubScenario(api, agentName, NODE_ID, "metric_rate", {
			rate: EVENTS_PER_SECOND,
			seconds: SECONDS,
		});

		const sampler = sampleProcess(agent.child.pid as number);
		ctx.log(`节点按每秒 ${EVENTS_PER_SECOND} 次上报 ${SECONDS} 秒`);
		const runId = await api.trigger(scenario);
		const task = await api.succeeded<RateOutputs>(
			runId,
			NODE_ID,
			ctx.signal,
			(SECONDS + 120) * 1000,
		);
		const usage = usageMeasurements(await sampler.stop(), AGENT, { rssMb: 2, cpuPercent: 2 });
		const { outputs } = task;
		const seq = await checkSeqMetric(
			api,
			{ runId, nodeId: NODE_ID, ...task },
			outputs.count,
			ctx.signal,
		);

		const measurements: Measurement[] = [
			{
				id: "missing_events",
				label: "丢失的事件（按序号核对）",
				value: seq.sequence.missing,
				unit: "个",
				check: hard("<=", 0),
			},
			{
				id: "duplicated_events",
				label: "重复的事件（按序号核对）",
				value: seq.sequence.duplicated,
				unit: "个",
				check: hard("<=", 0),
			},
			{
				id: "duplicate_points",
				label: "同一秒多出的指标点",
				value: seq.duplicatePoints,
				unit: "个",
				check: hard("<=", 0),
			},
			{
				id: "dropped_points",
				label: "Agent 丢弃的指标点",
				value: seq.droppedPoints,
				unit: "个",
				check: hard("<=", 0),
			},
			{
				id: "truncated",
				label: "指标数据被截断",
				value: seq.truncated ? 1 : 0,
				unit: "",
				check: hard("<=", 0),
			},
			{
				id: "event_rate",
				label: "实际上报速率",
				value: outputs.count / outputs.elapsed,
				unit: "次/秒",
				check: target(">=", EVENTS_PER_SECOND),
			},
			{
				id: "max_behind_ms",
				label: "节点比计划落后的最长时间",
				value: outputs.max_behind_ms,
				unit: "ms",
				noise: 5,
				check: target("<=", 1000),
			},
			{
				id: "max_call_ms",
				label: "单次 ctx.metric() 最长耗时",
				value: outputs.max_call_ms,
				unit: "ms",
				noise: 5,
			},
			usage.peak,
			usage.growth,
			usage.cpu,
		];
		return {
			measurements,
			series: [usage.series],
			notes: [
				`节点计划每秒上报 ${EVENTS_PER_SECOND} 次、共 ${SECONDS} 秒，实际上报 ${outputs.count} 次，用时 ${outputs.elapsed.toFixed(2)} 秒。`,
				`控制面收到 ${seq.buckets.length} 秒的点（写入 ${seq.writtenPoints} 个）；Agent 资源按 ${usage.series.points.length} 次采样计算，只算 Agent 进程本身。`,
			],
		};
	},
});
