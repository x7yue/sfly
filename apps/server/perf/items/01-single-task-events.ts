// 负载：单个任务以每秒 1 万次事件持续上报（ARCHITECTURE §7.6「单个任务 SDK → Agent」）。
// 桩节点 metric_rate 按定速上报 seq = 1, 2, …（ctx.metric 写 FIFO，ADR 0015），Agent 按秒合并后转发给控制面。
// 硬性断言：事件按序号核对不丢不重、每秒一个点、Agent 没有丢弃点、数据没有被截断。
// 只记录：实际速率与节点比计划落后的时间（节点是否被阻塞）、单次 ctx.metric() 最长耗时、Agent 内存与 CPU。
import { checkSequence } from "../checks.js";
import { definePerfItem, hard, type ItemRun, target } from "../item.js";
import type { Measurement } from "../report.js";
import { sampleProcess, sleep, startStack } from "../stack.js";
import { EVENTS_PER_SECOND } from "../targets.js";

const SECONDS = 30;
const MB = 1024 * 1024;

interface RateOutputs {
	count: number;
	elapsed: number;
	max_behind_ms: number;
	max_call_ms: number;
}

export default definePerfItem({
	id: "single-task-events",
	title: "单任务每秒 1 万次事件",
	scope: "单个任务 SDK → Agent",
	needsArtifacts: true,
	async run(ctx): Promise<ItemRun> {
		const { agent, agentName, api } = await startStack(ctx);
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

		const usage = sampleProcess(agent.child.pid as number);
		ctx.log(`节点按每秒 ${EVENTS_PER_SECOND} 次上报 ${SECONDS} 秒`);
		const runId = await api.trigger(orchestration);
		const view = await api.waitRun(runId, ctx.signal, (SECONDS + 120) * 1000);
		const agentUsage = await usage.stop();

		const node = view.chains[0]?.nodes.find((n) => n.node_id === "events");
		const attempt = node?.attempts.at(-1);
		if (view.status !== "success" || !attempt?.outputs) {
			throw new Error(`运行没有成功（${view.status}）：${JSON.stringify(attempt?.error ?? null)}`);
		}
		const outputs = attempt.outputs as unknown as RateOutputs;
		const chainInstanceId = view.chains[0]?.id as string;

		// 任务结束后控制面写完最后一段指标；等到最后一个点出现（丢了就等到超时，再如实核对）。
		const deadline = Date.now() + 20_000;
		let catalogAttempt:
			| Awaited<ReturnType<typeof api.metricCatalog>>["nodes"][number]["attempts"][number]
			| undefined;
		for (;;) {
			const catalog = await api.metricCatalog(runId);
			catalogAttempt = catalog.nodes.find((n) => n.node_id === "events")?.attempts.at(-1);
			const seq = catalogAttempt?.metrics.find((m) => m.name === "seq");
			if (seq?.last === outputs.count || Date.now() > deadline) break;
			await sleep(500, ctx.signal);
		}
		const series = await api.metricSeries(runId, chainInstanceId, "events");
		const buckets = series.series.find((s) => s.name === "seq")?.buckets ?? [];
		if (buckets.length > 0 && series.bucket_seconds !== 1) {
			throw new Error(`序列不是每秒一个桶（${series.bucket_seconds} 秒）`);
		}
		const writtenPoints = catalogAttempt?.metrics.find((m) => m.name === "seq")?.points ?? 0;
		const sequence = checkSequence(buckets, outputs.count);

		const measurements: Measurement[] = [
			{
				id: "missing_events",
				label: "丢失的事件（按序号核对）",
				value: sequence.missing,
				unit: "个",
				check: hard("<=", 0),
			},
			{
				id: "duplicated_events",
				label: "重复的事件（按序号核对）",
				value: sequence.duplicated,
				unit: "个",
				check: hard("<=", 0),
			},
			{
				id: "duplicate_points",
				label: "同一秒多出的指标点",
				// 同一秒写了两个点时，序列查询的桶点数与目录的写入点数都会多出来，取其一。
				value: Math.max(sequence.duplicatePoints, writtenPoints - buckets.length),
				unit: "个",
				check: hard("<=", 0),
			},
			{
				id: "dropped_points",
				label: "Agent 丢弃的指标点",
				value: catalogAttempt?.dropped_points ?? 0,
				unit: "个",
				check: hard("<=", 0),
			},
			{
				id: "truncated",
				label: "指标数据被截断",
				value: catalogAttempt?.truncated ? 1 : 0,
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
			{
				id: "agent_peak_rss_mb",
				label: "Agent 峰值内存（RSS）",
				value: agentUsage.peakRssBytes / MB,
				unit: "MB",
				noise: 2,
			},
			{
				id: "agent_rss_growth_mb",
				label: "Agent 内存增量（峰值 - 开始）",
				value: (agentUsage.peakRssBytes - agentUsage.startRssBytes) / MB,
				unit: "MB",
				noise: 2,
			},
			{
				id: "agent_cpu_percent",
				label: "Agent 平均 CPU（单核 = 100%）",
				value: agentUsage.cpuPercent,
				unit: "%",
				noise: 2,
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
				`节点计划每秒上报 ${EVENTS_PER_SECOND} 次、共 ${SECONDS} 秒，实际上报 ${outputs.count} 次，用时 ${outputs.elapsed.toFixed(2)} 秒。`,
				`控制面收到 ${buckets.length} 秒的点（写入 ${writtenPoints} 个）；Agent 资源按 ${agentUsage.samples.length} 次采样计算，只算 Agent 进程本身。`,
			],
		};
	},
});
