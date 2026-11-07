// 控制面接收指标的负载（ARCHITECTURE §7.6「控制面接收指标」，ADR 0009 的上限估算：
// 50 个运行 × 20 节点 × 10 指标 × 每秒 1 点 ≈ 1000 个任务 × 10 个指标）。
// 10 个讲真实 gRPC 的假 Agent 各领 100 个执行中的任务，每秒为每个任务上报一批 10 个点（perf/metric-load.ts）；
// 其中一个任务先补满 1 小时的历史数据，负载期间每秒查询一次它 1 小时范围的全部指标（运行页面的同一个请求）。
// 硬性断言：写入的点数与上报的一致（按「任务 × 指标」核对分段表与摘要）、没有被截断、控制面不积压。
// 「不积压」看两点：同步探测的往返时间不随时间增长（后半段中位数比前半段多出不超过 1 秒），
// 负载结束后排空的时间有上限。单次探测的最长往返只记录：控制面周期性地批量写库（每个任务每个指标的段
// 攒满 120 个点时同时关闭，1000 个任务就是上万行）会造成一次性的尖峰，处理完就回落，不是积压。
// 只记录：接收吞吐、1 小时范围查询的 p95（目标 < 500 ms）、控制面内存与 CPU。
// 用在 items/04-control-plane-metrics.ts（pnpm perf，默认 60 秒）与长时负载测试（soak.ts，跑满时长）。
import pg from "pg";
import { lateMedianGrowth } from "./checks.js";
import { target as goal, hard, type ItemRun, type PerfContext } from "./item.js";
import { distribution } from "./latency.js";
import { CONTROL_PLANE, usageMeasurements } from "./measure.js";
import {
	backfill,
	finishTasks,
	type LoadTask,
	planLoad,
	reconcilePoints,
	runLoad,
	startFleet,
} from "./metric-load.js";
import type { Measurement, Series } from "./report.js";
import { type PerfApi, sampleProcess, sleep } from "./stack.js";
import { INGEST_POINTS_PER_SECOND, INGEST_SECONDS, QUERY_P95_MS } from "./targets.js";

const METRICS_PER_TASK = 10;
const AGENTS = 10;
/** 查询的时间范围与补的历史数据：1 小时。 */
const HISTORY_SECONDS = INGEST_SECONDS;
/**
 * 积压增长的上限：同步探测往返后半段中位数比前半段多出的部分。处理能力比负载少 5% 时，
 * 60 秒的负载就会多出约 1.5 秒，1 小时多出约 90 秒；处理得过来时两半相差几十毫秒。
 */
const BACKLOG_GROWTH_LIMIT_MS = 1000;
/**
 * 排空时间的上限：负载结束时可能正赶上一批段同时关闭写库（每 120 秒一次，本机繁忙时这一下约 6 秒），
 * 再留一倍余量。积压时排空时间约等于积下的量：1 小时负载哪怕只差 1% 也有约 36 秒。
 */
const DRAIN_LIMIT_MS = 15_000;

/**
 * 分段表与摘要里 taskIds 这些任务每个「任务 × 指标」的点数，以及被截断的任务数、Agent 丢弃的点数（所有任务）。
 * 长时负载测试里同一个控制面上还有真实 Agent 的任务，核对点数时只算假 Agent 的。
 */
async function storedPoints(databaseUrl: string, taskIds: string[]) {
	const client = new pg.Client({ connectionString: databaseUrl });
	await client.connect();
	try {
		const toMap = (rows: Array<{ task_id: string; metric: string; points: string }>) =>
			new Map(rows.map((r) => [`${r.task_id}/${r.metric}`, Number(r.points)]));
		const segments = await client.query(
			"select task_id, metric, sum(points) as points from metric_segments where task_id = any($1::uuid[]) group by task_id, metric",
			[taskIds],
		);
		const series = await client.query(
			"select task_id, metric, points from metric_series where task_id = any($1::uuid[])",
			[taskIds],
		);
		const tasks = await client.query(
			"select count(*) filter (where metric_truncated) as truncated, coalesce(sum(metric_dropped), 0) as dropped from tasks",
		);
		return {
			segments: toMap(segments.rows),
			series: toMap(series.rows),
			truncated: Number(tasks.rows[0]?.truncated ?? 0),
			dropped: Number(tasks.rows[0]?.dropped ?? 0),
		};
	} finally {
		await client.end();
	}
}

/** 被测的控制面（已经启动）。 */
export interface ControlPlaneTarget {
	api: PerfApi;
	grpcUrl: string;
	databaseUrl: string;
	serverPid: number;
}

/**
 * 对已经启动的控制面施加每秒 1 万个点的接收负载，持续 seconds 秒，返回这一项的结果。
 * 被中断（ctx.signal）时提前结束，只交出已采集的数据，不核对写入的点数。
 */
export async function controlPlaneLoad(
	ctx: PerfContext,
	target: ControlPlaneTarget,
	seconds: number,
): Promise<ItemRun> {
	const api = target.api;
	const plan = planLoad({
		pointsPerSecond: INGEST_POINTS_PER_SECOND,
		metricsPerTask: METRICS_PER_TASK,
		agents: AGENTS,
	});
	const fleet = await startFleet({
		api,
		grpcUrl: target.grpcUrl,
		plan,
		metricsPerTask: METRICS_PER_TASK,
		log: (m) => ctx.log(m),
		defer: (c) => ctx.defer(c),
	});

	// 一个任务先补 1 小时的历史数据，查询它 1 小时范围的全部指标。
	const history = fleet.tasks[0] as LoadTask;
	const chainInstanceId = (await api.run(history.runId)).chains[0]?.id as string;
	const firstSecond = Math.floor(Date.now() / 1000) + 2;
	ctx.log(`补 ${HISTORY_SECONDS} 秒的历史数据（${HISTORY_SECONDS * METRICS_PER_TASK} 个点）`);
	await backfill(fleet, history, firstSecond, HISTORY_SECONDS);
	let lastQueryPoints = 0;
	const query = async () => {
		const now = Date.now();
		const params = new URLSearchParams({
			chain_instance_id: chainInstanceId,
			node_id: "load",
			from: new Date(now - HISTORY_SECONDS * 1000).toISOString(),
			to: new Date(now).toISOString(),
		});
		const body = (await api.getJson(`/runs/${history.runId}/metrics/series?${params}`)) as {
			series: Array<{ buckets: Array<{ points: number }> }>;
		};
		lastQueryPoints = body.series.reduce(
			(n, s) => n + s.buckets.reduce((m, b) => m + b.points, 0),
			0,
		);
	};

	ctx.log(`${AGENTS} 个假 Agent 每秒共上报 ${plan.pointsPerSecond} 个点，持续 ${seconds} 秒`);
	const sampler = sampleProcess(target.serverPid, 500);
	const load = await runLoad({
		fleet,
		firstSecond: Math.floor(Date.now() / 1000) + 1,
		seconds: Math.ceil(seconds),
		query,
		signal: ctx.signal,
		log: (m) => ctx.log(m),
	});
	const usage = usageMeasurements(await sampler.stop(), CONTROL_PLANE, {
		rssMb: 20,
		cpuPercent: 5,
	});
	const realtimePoints =
		[...load.sentSeconds.values()].reduce((a, b) => a + b, 0) * METRICS_PER_TASK;
	const probeRtt = distribution(load.probes.map((p) => p.rttMs));
	const backlogGrowth = lateMedianGrowth(load.probes.map((p) => [p.ms, p.rttMs]));
	const queryMs = distribution(load.queries.map((q) => q.durationMs));
	const loadNote = `${AGENTS} 个假 Agent、${plan.tasks} 个任务 × ${METRICS_PER_TASK} 个指标，计划每秒 ${plan.pointsPerSecond} 个点、持续 ${seconds} 秒；实际上报 ${load.seconds} 秒、${realtimePoints} 个点（另补历史数据 ${HISTORY_SECONDS * METRICS_PER_TASK} 个点）。`;
	const queryNote = `查询 ${queryMs?.count ?? 0} 次（每次 ${METRICS_PER_TASK} 个指标、默认 300 个桶），最后一次返回 ${lastQueryPoints} 个点；同步探测 ${probeRtt?.count ?? 0} 次。`;
	const recorded: Measurement[] = [
		{
			id: "backlog_growth_ms",
			label: "积压增长（同步探测往返：后半段中位数 - 前半段中位数）",
			value: backlogGrowth ?? Number.NaN,
			unit: "ms",
			noise: 50,
			check: hard("<=", BACKLOG_GROWTH_LIMIT_MS),
		},
		{
			id: "max_probe_ms",
			label: "同步探测往返最长（含批量写库的一次性尖峰）",
			value: probeRtt?.max ?? Number.NaN,
			unit: "ms",
			noise: 50,
		},
		{
			id: "query_p95_ms",
			label: "1 小时范围的指标查询 p95",
			value: queryMs?.p95 ?? Number.NaN,
			unit: "ms",
			noise: 20,
			check: goal("<=", QUERY_P95_MS),
		},
		{
			id: "query_p50_ms",
			label: "1 小时范围的指标查询 p50",
			value: queryMs?.p50 ?? Number.NaN,
			unit: "ms",
			noise: 20,
		},
		{
			id: "query_max_ms",
			label: "1 小时范围的指标查询最长",
			value: queryMs?.max ?? Number.NaN,
			unit: "ms",
			noise: 50,
		},
		{
			id: "probe_p95_ms",
			label: "同步探测往返 p95",
			value: probeRtt?.p95 ?? Number.NaN,
			unit: "ms",
			noise: 20,
		},
		{
			id: "send_behind_ms",
			label: "假 Agent 比计划晚发的最长时间",
			value: load.maxSendBehindMs,
			unit: "ms",
			noise: 50,
		},
		usage.peak,
		usage.growth,
		usage.cpu,
	];
	const series: Series[] = [
		usage.series,
		{
			id: "probe_rtt",
			label: "同步探测往返（积压）",
			unit: "ms",
			points: load.probes.map((p) => [p.ms, p.rttMs]),
		},
		{
			id: "query_ms",
			label: "1 小时范围的指标查询耗时",
			unit: "ms",
			points: load.queries.map((q) => [q.ms, q.durationMs]),
		},
	];
	if (ctx.signal.aborted) {
		// 被中断：控制面可能已经随 Ctrl-C 退出，不再排空、核对写入的点数，只交出已采集的数据。
		return {
			measurements: recorded,
			series,
			notes: [loadNote, "被中断：没有排空，也没有核对写入的点数。", queryNote],
		};
	}

	ctx.log("任务上报成功，等控制面写完全部的点");
	await finishTasks(fleet);
	const sent = new Map<string, number>();
	for (const t of fleet.tasks) {
		const n = (load.sentSeconds.get(t) ?? 0) + (t === history ? HISTORY_SECONDS : 0);
		for (const metric of fleet.metrics) sent.set(`${t.task.taskId}/${metric}`, n);
	}
	const taskIds = fleet.tasks.map((t) => t.task.taskId);
	let stored = await storedPoints(target.databaseUrl, taskIds);
	const deadline = Date.now() + 30_000;
	while (
		reconcilePoints(sent, stored.segments).missing > 0 &&
		Date.now() < deadline &&
		!ctx.signal.aborted
	) {
		await sleep(1000, ctx.signal);
		stored = await storedPoints(target.databaseUrl, taskIds);
	}
	const segments = reconcilePoints(sent, stored.segments);
	const summaries = reconcilePoints(sent, stored.series);

	const windowMs = Math.max(load.seconds * 1000, load.seconds * 1000 + load.drainMs - 1000);

	const measurements: Measurement[] = [
		{
			id: "missing_points",
			label: "上报了但没写进分段表的点",
			value: Math.max(segments.missing, summaries.missing),
			unit: "个",
			check: hard("<=", 0),
		},
		{
			id: "extra_points",
			label: "比上报多写的点（重复写入）",
			value: Math.max(segments.extra, summaries.extra),
			unit: "个",
			check: hard("<=", 0),
		},
		{
			id: "truncated_tasks",
			label: "指标数据被截断的任务",
			value: stored.truncated,
			unit: "个",
			check: hard("<=", 0),
		},
		{
			id: "ingest_rate",
			label: "接收吞吐",
			value: realtimePoints / (windowMs / 1000),
			unit: "点/秒",
			check: goal(">=", INGEST_POINTS_PER_SECOND),
		},
		{
			id: "drain_ms",
			label: "最后一批发出后排空的时间",
			value: load.drainMs,
			unit: "ms",
			noise: 50,
			check: hard("<=", DRAIN_LIMIT_MS),
		},
		...recorded,
	];
	return {
		measurements,
		series,
		notes: [
			loadNote,
			`写入分段表 ${segments.stored} 个点、摘要 ${summaries.stored} 个点，上报 ${segments.sent} 个；Agent 丢弃计数 ${stored.dropped}。`,
			queryNote,
		],
	};
}
