// 负载：从节点调用 ctx.metric() 到运行页面收到 SSE 推送的端到端延迟（ARCHITECTURE §7.6「端到端延迟」）。
// 真实 SDK（桩节点 metric_clock 每秒 1 万次上报调用时刻）→ release Agent（按秒合并）→ 打包后的控制面 →
// 运行事件流 `GET /runs/:id/events` 的 metrics 事件，与运行页面订阅的是同一条流。
// 每秒一个点：min 是这一秒第一次调用的时刻，收到推送的时刻减去它就是用户最多要等多久（first）。
// 硬性断言：控制面写入的每一秒都推送到了事件流（没有断线，不该漏推）。
// 只记录：延迟分布（p50 / p95 / p99 / 最长），最长与目标 3 秒比较。
// 持续时间默认 30 秒，可以用环境变量 SFLY_PERF_END_TO_END_SECONDS 调整。
import { MetricIncrement as metricIncrement } from "@sfly/schema";
import { definePerfItem, hard, type ItemRun, type PerfContext, target } from "../item.js";
import { distribution, type PushLatency, pushLatencies } from "../latency.js";
import { durationSeconds } from "../metric-load.js";
import type { Measurement } from "../report.js";
import { openSse } from "../sse.js";
import { sleep, startStack } from "../stack.js";
import { stubScenario } from "../stub.js";
import { END_TO_END_MS, EVENTS_PER_SECOND } from "../targets.js";

export const SECONDS_ENV = "SFLY_PERF_END_TO_END_SECONDS";
const DEFAULT_SECONDS = 30;
const METRIC = "clock_ms";
const NODE_ID = "clock";

interface ClockOutputs {
	count: number;
	elapsed: number;
}

/** 端到端延迟；seconds 不传时读环境变量 {@link SECONDS_ENV}（默认 30 秒）。 */
export function endToEndLatency(seconds?: number) {
	return definePerfItem({
		id: "end-to-end-latency",
		title: "ctx.metric() 到运行页面收到推送的延迟",
		scope: "端到端延迟",
		needsArtifacts: true,
		run: (ctx) => run(ctx, seconds ?? durationSeconds(process.env, SECONDS_ENV, DEFAULT_SECONDS)),
	});
}

async function run(ctx: PerfContext, seconds: number): Promise<ItemRun> {
	const { agentName, api, server } = await startStack(ctx);
	const scenario = await stubScenario(api, agentName, NODE_ID, "metric_clock", {
		rate: EVENTS_PER_SECOND,
		seconds,
	});

	ctx.log(`节点每秒 ${EVENTS_PER_SECOND} 次上报调用时刻，持续 ${seconds} 秒；运行事件流上测延迟`);
	const runId = await api.trigger(scenario);
	const latencies: PushLatency[] = [];
	// 执行器启动要几百毫秒，节点的第一次上报一定在订阅之后。
	const sse = await openSse(`${server.httpUrl}/runs/${runId}/events`, (event, receivedAtMs) => {
		if (event.event !== "metrics") return;
		const increment = metricIncrement.parse(event.data);
		if (increment.node_id === NODE_ID) {
			latencies.push(...pushLatencies(increment, METRIC, receivedAtMs));
		}
	});
	ctx.defer(() => sse.close());
	const { outputs, chainInstanceId } = await api.succeeded<ClockOutputs>(
		runId,
		NODE_ID,
		ctx.signal,
		(seconds + 120) * 1000,
	);
	// 任务结束时 Agent 补发最后一秒；等它推送过来再关闭事件流。
	await sleep(2000, ctx.signal);
	sse.close();

	const series = await api.metricSeries(runId, chainInstanceId, NODE_ID);
	const stored = (series.series.find((s) => s.name === METRIC)?.buckets ?? []).map(
		(b) => Date.parse(b.time) / 1000,
	);
	const pushed = new Set(latencies.map((l) => l.second));
	const first = distribution(latencies.map((l) => l.first));
	const last = distribution(latencies.map((l) => l.last));
	/** 曲线的时间原点：第一个推送的点所在的秒。 */
	const origin = latencies[0]?.second ?? 0;

	const measurements: Measurement[] = [
		{
			id: "unpushed_seconds",
			label: "写入了但没有推送到事件流的秒数",
			value: stored.filter((s) => !pushed.has(s)).length,
			unit: "秒",
			check: hard("<=", 0),
		},
		{
			id: "latency_max_ms",
			label: "端到端延迟最长（这一秒第一次调用起算）",
			value: first?.max ?? Number.NaN,
			unit: "ms",
			noise: 100,
			check: target("<=", END_TO_END_MS),
		},
		{
			id: "latency_p99_ms",
			label: "端到端延迟 p99（第一次调用起算）",
			value: first?.p99 ?? Number.NaN,
			unit: "ms",
			noise: 100,
		},
		{
			id: "latency_p95_ms",
			label: "端到端延迟 p95（第一次调用起算）",
			value: first?.p95 ?? Number.NaN,
			unit: "ms",
			noise: 100,
		},
		{
			id: "latency_p50_ms",
			label: "端到端延迟 p50（第一次调用起算）",
			value: first?.p50 ?? Number.NaN,
			unit: "ms",
			noise: 100,
		},
		{
			id: "latency_last_p50_ms",
			label: "端到端延迟 p50（最后一次调用起算）",
			value: last?.p50 ?? Number.NaN,
			unit: "ms",
			noise: 100,
		},
		{
			id: "event_rate",
			label: "节点实际上报速率",
			value: outputs.count / outputs.elapsed,
			unit: "次/秒",
			check: target(">=", EVENTS_PER_SECOND),
		},
	];
	return {
		measurements,
		series: [
			{
				id: "latency_first",
				label: "端到端延迟（每秒第一次调用起算）",
				unit: "ms",
				points: latencies.map((l) => [(l.second - origin) * 1000, l.first]),
			},
		],
		notes: [
			`节点上报 ${outputs.count} 次、用时 ${outputs.elapsed.toFixed(2)} 秒；控制面写入 ${stored.length} 秒的点，事件流推送 ${latencies.length} 秒（${pushed.size} 个不同的秒）。`,
			"延迟 = 收到推送的时刻 - 调用 ctx.metric() 的时刻，两者都读本机时钟；Agent 每秒合并一次，所以第一次调用起算的延迟至少接近 1 秒。",
		],
	};
}

export default endToEndLatency();
