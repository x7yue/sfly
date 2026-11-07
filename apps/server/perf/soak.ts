// 长时负载测试（ARCHITECTURE §7.6）：`pnpm perf:soak`，默认 1 小时（--duration 指定），只在维护者要求时运行。
// 不放在 perf/items/ 下：pnpm perf 不运行它。
//
// 复现 #69 那样的持续压测，同一个打包后的控制面上同时施加两类负载：
// - 控制面接收指标：与 pnpm perf 的 control-plane-metrics 相同（perf/control-plane-load.ts），跑满时长，
//   对应 §7.6「持续每秒 1 万点 1 小时不积压；1 小时范围的指标查询 p95 < 500 ms」；
// - 真实的 release Agent（4 个槽位）：一个任务从头到尾以每秒 1 万次上报指标（metric_rate），另外两个槽位
//   不停地一个接一个执行短任务——定速输出 stdout（日志副本轮换）和短时上报指标（任务目录的创建与删除）。
//   Agent 以 --task-dir-retention 0 启动，结果确认后立即删除任务目录，工作目录占用只反映执行中的任务。
//
// 报告里有随时间变化的数据：Agent 与控制面内存、Agent 工作目录占用、控制面数据目录与数据库大小、
// 控制面里的指标点数、完成的任务数。硬性断言：Agent 内存增量 ≤ 100 MB、工作目录占用有上限、短任务都成功、
// 长任务的事件按序号核对不丢不重，以及控制面负载的那些断言；后半段比前半段多出的峰值只记录，用来看缓慢泄漏。
//
// 中途按 Ctrl-C：两类负载都停下，已采集的数据照常写进报告（没有运行完的检查不做），报告标为被中断。
import { join } from "node:path";
import pg from "pg";
import { checkSequence, lateGrowth, type SecondBucket, secondWindows } from "./checks.js";
import { controlPlaneLoad } from "./control-plane-load.js";
import { dirUsage, sampleEvery } from "./disk.js";
import { definePerfItem, hard, type ItemRun, type PerfContext, target } from "./item.js";
import type { Measurement, Series } from "./report.js";
import { type PerfApi, type Stack, sampleProcess, sleep, startStack } from "./stack.js";

const SLOTS = 4;
/** 长任务的上报速率（§7.6「单个任务 SDK → Agent」）。 */
const LONG_RATE = 10_000;
/** 定速输出的短任务：12 MiB 超过 8 MiB，每个任务都会轮换一次日志副本；总量远低于控制面单任务日志上限 200 MiB。 */
const STDOUT_TASK = { mib_per_second: 0.2, seconds: 60, line_bytes: 1024 };
/** 短时上报指标的任务。 */
const SHORT_TASK = { rate: 1000, seconds: 5 };
/**
 * 工作目录占用的上限：执行中的任务里只有定速输出的会写文件（stdout.log 最多两个 8 MiB），
 * 再算上刚结束、正在后台删除的上一个任务的同样一份，加上余量。事件落盘（#69）时长任务每秒约 0.5 MB，很快超出。
 */
const WORK_DIR_LIMIT_MB = 48;
const MB = 1024 * 1024;

/** 随时间变化的数据的采样间隔：1 小时约 720 个点，最短 1 秒、最长 10 秒。 */
export const sampleIntervalMs = (seconds: number) =>
	Math.min(10_000, Math.max(1000, Math.round((seconds * 1000) / 720)));

/** 长时负载测试，持续 seconds 秒。 */
export function soak(seconds: number) {
	return definePerfItem({
		id: "soak",
		title: "长时负载测试",
		scope: "控制面接收指标",
		needsArtifacts: true,
		run: (ctx) => run(ctx, seconds),
	});
}

async function run(ctx: PerfContext, seconds: number): Promise<ItemRun> {
	const stack = await startStack(ctx, {
		agentArgs: ["--slots", String(SLOTS), "--task-dir-retention", "0"],
	});
	// 一类负载没法测下去（抛出）时停下另一类；用户中断时两类都会收到。
	const stop = new AbortController();
	const onAbort = () => stop.abort(ctx.signal.reason);
	ctx.signal.addEventListener("abort", onAbort, { once: true });
	const partCtx = (prefix: string): PerfContext => ({
		...ctx,
		signal: stop.signal,
		log: (m) => ctx.log(`${prefix}：${m}`),
	});
	const guard = <T>(part: Promise<T>) =>
		part.catch((error: unknown) => {
			stop.abort(error);
			throw error;
		});
	const [controlPlane, agent] = await Promise.allSettled([
		guard(
			controlPlaneLoad(
				partCtx("控制面"),
				{
					api: stack.api,
					grpcUrl: stack.server.grpcUrl,
					databaseUrl: stack.database.url,
					serverPid: stack.server.child.pid as number,
				},
				seconds,
			),
		),
		guard(agentLoad(partCtx("Agent"), stack, seconds)),
	]);
	ctx.signal.removeEventListener("abort", onAbort);

	const notes: string[] = [];
	const parts: ItemRun[] = [];
	for (const [name, outcome] of [
		["Agent 负载", agent],
		["控制面负载", controlPlane],
	] as const) {
		if (outcome.status === "fulfilled") {
			parts.push(outcome.value);
			continue;
		}
		// 没有被中断却没法测下去：这一项出错。被中断时另一类负载的数据照常写进报告。
		if (!ctx.signal.aborted) throw outcome.reason;
		const reason = outcome.reason;
		notes.push(
			`${name}被中断时出错，没有数据：${reason instanceof Error ? reason.message : String(reason)}`,
		);
	}
	const measurements = parts.flatMap((p) => p.measurements);
	const series = parts.flatMap((p) => p.series ?? []);
	const serverRss = series.find((s) => s.id === "server_rss");
	const serverLate = serverRss ? lateGrowth(serverRss.points) : null;
	if (serverLate !== null) {
		measurements.push({
			id: "server_rss_late_growth_mb",
			label: "控制面内存：后半段峰值比前半段多出",
			value: serverLate,
			unit: "MB",
			noise: 20,
		});
	}
	return { measurements, series, notes: [...notes, ...parts.flatMap((p) => p.notes ?? [])] };
}

interface RateOutputs {
	count: number;
	elapsed: number;
	max_behind_ms: number;
	max_call_ms: number;
}

/** 场景：入口 → 一个桩节点。 */
function orchestration(stack: Stack, name: string, node: string, inputs: unknown) {
	return stack.api.createOrchestration(
		{
			default_agent: stack.agentName,
			nodes: [
				{ id: "entry", kind: "entry" },
				{ id: "load", kind: "package", package: "sfly-stub", node, inputs },
			],
			edges: [{ from: "entry", to: "load", kind: "chain" }],
			packages: { "sfly-stub": "0.1.0" },
		},
		name,
	);
}

/** 不停地一个接一个运行同一个场景，直到剩下的时间不够再执行一次（或被中断）。 */
async function repeat(
	api: PerfApi,
	orchestrationId: string,
	taskSeconds: number,
	deadlineMs: number,
	signal: AbortSignal,
	onFinished: () => void,
) {
	let finished = 0;
	const failures: string[] = [];
	while (!signal.aborted && Date.now() + taskSeconds * 1000 <= deadlineMs) {
		try {
			const runId = await api.trigger(orchestrationId);
			const view = await api.waitRun(runId, signal, (taskSeconds + 120) * 1000);
			if (signal.aborted) break;
			finished++;
			if (view.status !== "success") failures.push(`${runId}：${view.status}`);
			onFinished();
		} catch (error) {
			if (signal.aborted) break;
			throw error;
		}
	}
	return { finished, failures };
}

/** 长任务结束后，分段查询它整个时长的 seq 序列（每秒一个桶），按序号核对。 */
async function checkLongTask(api: PerfApi, runId: string, signal: AbortSignal) {
	const view = await api.waitRun(runId, signal, 300_000);
	const attempt = view.chains[0]?.nodes.find((n) => n.node_id === "load")?.attempts.at(-1);
	if (view.status !== "success" || !attempt?.outputs || !attempt.started_at || !attempt.ended_at) {
		throw new Error(`长任务没有成功（${view.status}）：${JSON.stringify(attempt?.error ?? null)}`);
	}
	const outputs = attempt.outputs as unknown as RateOutputs;
	// 等最后一个点写进控制面。
	const deadline = Date.now() + 30_000;
	const catalogAttempt = async () =>
		(await api.metricCatalog(runId)).nodes.find((n) => n.node_id === "load")?.attempts.at(-1);
	let written = await catalogAttempt();
	while (
		written?.metrics.find((m) => m.name === "seq")?.last !== outputs.count &&
		Date.now() < deadline
	) {
		await sleep(500, signal);
		written = await catalogAttempt();
	}
	const metric = written?.metrics.find((m) => m.name === "seq");
	const chainInstanceId = view.chains[0]?.id as string;
	const buckets: SecondBucket[] = [];
	const first = Math.floor(Date.parse(attempt.started_at) / 1000) - 1;
	const last = Math.ceil(Date.parse(attempt.ended_at) / 1000) + 1;
	for (const [from, to] of secondWindows(first, last, 3600)) {
		const series = await api.metricSeriesRange(runId, chainInstanceId, "load", from, to);
		const part = series.series.find((s) => s.name === "seq")?.buckets ?? [];
		if (part.length > 0 && series.bucket_seconds !== 1) {
			throw new Error(`序列不是每秒一个桶（${series.bucket_seconds} 秒）`);
		}
		buckets.push(...part);
	}
	const sequence = checkSequence(buckets, outputs.count);
	return {
		outputs,
		sequence,
		duplicatePoints: Math.max(sequence.duplicatePoints, (metric?.points ?? 0) - buckets.length),
		droppedPoints: written?.dropped_points ?? 0,
		truncated: written?.truncated ?? false,
	};
}

/** 控制面数据库里的指标点数与数据库大小。 */
async function databaseStats(client: pg.Client) {
	const { rows } = await client.query<{ points: string; bytes: string }>(
		"select (select coalesce(sum(points), 0) from metric_series) as points, pg_database_size(current_database()) as bytes",
	);
	return { points: Number(rows[0]?.points ?? 0), bytes: Number(rows[0]?.bytes ?? 0) };
}

async function agentLoad(ctx: PerfContext, stack: Stack, seconds: number): Promise<ItemRun> {
	const { api, agent } = stack;
	const [long, stdout, short] = await Promise.all([
		orchestration(stack, "soak-long", "metric_rate", { rate: LONG_RATE, seconds }),
		orchestration(stack, "soak-stdout", "stdout_rate", STDOUT_TASK),
		orchestration(stack, "soak-short", "metric_rate", SHORT_TASK),
	]);
	const client = new pg.Client({ connectionString: stack.database.url });
	await client.connect();
	ctx.defer(() => client.end());

	const intervalMs = sampleIntervalMs(seconds);
	const tasksDir = join(agent.workDir, "tasks");
	const startedAt = Date.now();
	const agentUsage = sampleProcess(agent.child.pid as number, intervalMs);
	const workDir = sampleEvery(() => dirUsage(tasksDir), intervalMs);
	const dataDir = sampleEvery(() => dirUsage(stack.dataDir), intervalMs);
	const database = sampleEvery(() => databaseStats(client), intervalMs);
	const finishedAt: number[] = [];
	const onFinished = () => finishedAt.push(Date.now() - startedAt);

	ctx.log(
		`${SLOTS} 个槽位：一个任务每秒上报 ${LONG_RATE} 次、持续 ${seconds} 秒；两个槽位轮流执行定速输出与短时上报的任务`,
	);
	const deadline = startedAt + seconds * 1000;
	const longRun = await api.trigger(long);
	const progress = setInterval(() => {
		const minutes = ((Date.now() - startedAt) / 60_000).toFixed(1);
		ctx.log(`已运行 ${minutes} 分钟，完成短任务 ${finishedAt.length} 个`);
	}, 60_000);
	let loops: Array<{ finished: number; failures: string[] }>;
	try {
		loops = await Promise.all([
			repeat(api, stdout, STDOUT_TASK.seconds, deadline, ctx.signal, onFinished),
			repeat(api, short, SHORT_TASK.seconds, deadline, ctx.signal, onFinished),
		]);
		// 短任务停下之后，等长任务跑满时长（被中断时立即停下；sleep 只响应等待期间发生的中断）。
		if (!ctx.signal.aborted) {
			await sleep(Math.max(0, deadline - Date.now()), ctx.signal).catch(() => undefined);
		}
	} finally {
		clearInterval(progress);
	}
	let longTask: Awaited<ReturnType<typeof checkLongTask>> | null = null;
	if (!ctx.signal.aborted) {
		ctx.log("等长任务结束，按序号核对它的事件");
		try {
			longTask = await checkLongTask(api, longRun, ctx.signal);
		} catch (error) {
			if (!ctx.signal.aborted) throw error;
		}
	}
	const [usage, workSamples, dataSamples, dbSamples] = await Promise.all([
		agentUsage.stop(),
		workDir.stop(),
		dataDir.stop(),
		database.stop(),
	]);
	const ranSeconds = (Date.now() - startedAt) / 1000;

	const toSeries = <T>(samples: Array<{ ms: number; value: T }>, pick: (v: T) => number) =>
		samples.map((s): [number, number] => [s.ms - startedAt, pick(s.value)]);
	const agentRss = usage.samples.map((p): [number, number] => [p.ms, p.rssBytes / MB]);
	const workMb = toSeries(workSamples, (v) => v / MB);
	const dataMb = toSeries(dataSamples, (v) => v / MB);
	const points = toSeries(dbSamples, (v) => v.points);
	const dbMb = toSeries(dbSamples, (v) => v.bytes / MB);
	const peak = (s: Array<[number, number]>) => s.reduce((m, [, v]) => Math.max(m, v), 0);
	const growth = (s: Array<[number, number]>) => (s.at(-1)?.[1] ?? 0) - (s[0]?.[1] ?? 0);
	const failures = loops.flatMap((l) => l.failures);
	const finished = loops.reduce((n, l) => n + l.finished, 0);

	const measurements: Measurement[] = [
		{
			id: "agent_rss_growth_mb",
			label: "Agent 内存增量（峰值 - 开始）",
			value: (usage.peakRssBytes - usage.startRssBytes) / MB,
			unit: "MB",
			noise: 5,
			check: hard("<=", 100),
		},
		{
			id: "work_dir_peak_mb",
			label: "Agent 工作目录峰值占用",
			value: peak(workMb),
			unit: "MB",
			noise: 2,
			check: hard("<=", WORK_DIR_LIMIT_MB),
		},
		{
			id: "failed_tasks",
			label: "没有成功的短任务",
			value: failures.length,
			unit: "个",
			check: hard("<=", 0),
		},
	];
	if (longTask) {
		const { outputs, sequence } = longTask;
		measurements.push(
			{
				id: "missing_events",
				label: "长任务丢失的事件（按序号核对）",
				value: sequence.missing,
				unit: "个",
				check: hard("<=", 0),
			},
			{
				id: "duplicated_events",
				label: "长任务重复的事件（按序号核对）",
				value: sequence.duplicated,
				unit: "个",
				check: hard("<=", 0),
			},
			{
				id: "duplicate_points",
				label: "长任务同一秒多出的指标点",
				value: longTask.duplicatePoints,
				unit: "个",
				check: hard("<=", 0),
			},
			{
				id: "dropped_points",
				label: "长任务被 Agent 丢弃的指标点",
				value: longTask.droppedPoints,
				unit: "个",
				check: hard("<=", 0),
			},
			{
				id: "long_truncated",
				label: "长任务的指标数据被截断",
				value: longTask.truncated ? 1 : 0,
				unit: "个",
				check: hard("<=", 0),
			},
			{
				id: "long_event_rate",
				label: "长任务的实际上报速率",
				value: outputs.count / outputs.elapsed,
				unit: "次/秒",
				check: target(">=", LONG_RATE),
			},
			{
				id: "long_max_behind_ms",
				label: "长任务比计划落后的最长时间",
				value: outputs.max_behind_ms,
				unit: "ms",
				noise: 5,
				check: target("<=", 1000),
			},
			{
				id: "long_max_call_ms",
				label: "长任务单次 ctx.metric() 最长耗时",
				value: outputs.max_call_ms,
				unit: "ms",
				noise: 5,
			},
		);
	}
	const late = (id: string, label: string, s: Array<[number, number]>, noise: number) => {
		const value = lateGrowth(s);
		if (value !== null) measurements.push({ id, label, value, unit: "MB", noise });
	};
	late("agent_rss_late_growth_mb", "Agent 内存：后半段峰值比前半段多出", agentRss, 5);
	late("work_dir_late_growth_mb", "Agent 工作目录：后半段峰值比前半段多出", workMb, 2);
	measurements.push(
		{
			id: "agent_peak_rss_mb",
			label: "Agent 峰值内存（RSS）",
			value: usage.peakRssBytes / MB,
			unit: "MB",
			noise: 5,
		},
		{
			id: "agent_cpu_percent",
			label: "Agent 平均 CPU（单核 = 100%）",
			value: usage.cpuPercent,
			unit: "%",
			noise: 5,
		},
		{
			id: "finished_tasks",
			label: "完成的短任务",
			value: finished,
			unit: "个",
			noise: 5,
		},
		{
			id: "stored_points",
			label: "控制面里的指标点数（结束时，所有任务）",
			value: points.at(-1)?.[1] ?? 0,
			unit: "个",
		},
		{
			id: "database_growth_mb",
			label: "控制面数据库增长",
			value: growth(dbMb),
			unit: "MB",
			noise: 20,
		},
		{
			id: "server_data_growth_mb",
			label: "控制面数据目录增长（任务日志等）",
			value: growth(dataMb),
			unit: "MB",
			noise: 20,
		},
	);

	const series: Series[] = [
		{ id: "agent_rss", label: "Agent 内存（RSS）", unit: "MB", points: agentRss },
		{ id: "work_dir", label: "Agent 工作目录占用", unit: "MB", points: workMb },
		{ id: "stored_points", label: "控制面里的指标点数", unit: "个", points },
		{ id: "database_size", label: "控制面数据库大小", unit: "MB", points: dbMb },
		{ id: "server_data_dir", label: "控制面数据目录占用", unit: "MB", points: dataMb },
		{
			id: "finished_tasks",
			label: "完成的短任务（累计）",
			unit: "个",
			points: finishedAt.map((ms, i): [number, number] => [ms, i + 1]),
		},
	];
	const notes = [
		ctx.signal.aborted
			? `被中断：计划 ${seconds} 秒，实际运行 ${ranSeconds.toFixed(0)} 秒；长任务没有运行完，没有核对它的事件。`
			: `Agent 负载运行 ${ranSeconds.toFixed(0)} 秒（计划 ${seconds} 秒）。`,
		`长任务每秒上报 ${LONG_RATE} 次${longTask ? `，实际 ${longTask.outputs.count} 次 / ${longTask.outputs.elapsed.toFixed(1)} 秒` : ""}；` +
			`定速输出任务每个 ${STDOUT_TASK.mib_per_second} MiB/秒 × ${STDOUT_TASK.seconds} 秒、短时上报任务每个 ${SHORT_TASK.rate} 次/秒 × ${SHORT_TASK.seconds} 秒，共完成 ${finished} 个。`,
		`随时间变化的数据每 ${intervalMs / 1000} 秒采样一次；Agent 以 --task-dir-retention 0 启动，工作目录占用只反映执行中的任务。`,
		...failures.slice(0, 5).map((f) => `没有成功的短任务：${f}`),
	];
	return { measurements, series, notes };
}
