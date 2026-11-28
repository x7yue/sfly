// 基准测试（docs/ARCHITECTURE.md §7.6）：控制面的指标分段写入与降采样查询耗时（vitest bench）。只在本地运行，不进 CI：
// `vitest run` 只选 test/**/*.test.ts，基准测试只在 `vitest bench` 下运行；`pnpm perf` 顺带运行并汇总进报告
// （perf/items/09-bench-control-plane.ts）。需要本机 PostgreSQL（与控制面测试相同，DATABASE_URL）。
//
// 单独运行：`pnpm --filter @sfly/server exec vitest bench --run perf/benchmarks/control-plane.bench.ts`
//
// 直接驱动 TaskMetrics / MetricQueries（src/metrics），不经过 gRPC 与 HTTP：测的是写入与查询本身。
// 任务、场景与节点包声明经由测试用控制面和假 Agent 正常创建（与控制面测试相同）。
//
// - segment_write：一个任务 10 个指标，按 Agent 的节奏每秒一批（每个指标一个点）接收 120 秒——
//   最后一批让 10 段同时攒满，在一个事务里整段写入（ADR 0009）；一次迭代 = 1200 个点。
// - query_300 / query_12：1 小时、10 个指标（36000 个点，全部已写库）的序列查询，分别降采样到
//   300 个桶（运行页面的默认值，段跨多个桶，要展开数组）和 12 个桶（多数段落在一个桶里，直接用段摘要）。
// - segment_write_labeled / query_300_labeled：同样的写入与 300 个桶的查询，但是 4 个带标签（pid、name）的指标
//   × 50 个进程，共 200 个序列（按进程上报的节点，例如 sfly-std 的辅助函数 monitor_processes）：一次写入迭代 = 24000 个点、
//   200 段；查询的数据是 1 小时 × 200 个序列（72 万个点）。
// - query_300_chart_50 / query_300_chart_100：同一份带标签的数据，按运行监控页的用法只查一张图表引用的指标
//   （#153）：1 个指标（50 个序列）、2 个指标（100 个序列，sfly-std 的辅助函数 monitor_processes 最大的按进程图表），300 个桶。
// - focus_*：关注项读数（resolveRunFocus）的读法，`taskSeries` 带 `recent`（每个序列另给最近 10 个点的时间，算采样间隔），
//   与不带 `recent` 的同一个查询成对出现，差值就是多读的那一次（数据都已写库，每次都要读库里最近的段）：
//   focus_1 是 10 个指标、1 个桶（只要最新值的读数），focus_60_chart_100 是一张图表的 2 个带标签指标（100 个序列）、
//   60 个桶（概览的图表）。
// - focus_c8_* / focus_c32_*：同样的两种读法，8 个、32 个并发读同一个任务（几个人同时开着概览，每 2 秒各读一次），
//   带与不带 `recent`；一次迭代 = 一批并发读，吞吐 = 并发数 / 平均耗时。延迟之外，同一个测试再用 pg_stat_database
//   在每种情况前后取差，打印每次读的库访问量（`[focus-db]` 开头的几行），看带 `recent` 多给数据库添了多少负载。
import { create } from "@bufbuild/protobuf";
import { MetricBatchSchema } from "@sfly/proto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, test } from "vitest";
import { ConnectionClock } from "../../src/agents/agent-clock.js";
import { type Database, openDatabase } from "../../src/db/database.js";
import { tasks } from "../../src/db/schema.js";
import { SAMPLE_POINTS } from "../../src/focus/focus-anomaly.js";
import { TaskLogs } from "../../src/logs/task-logs.js";
import { MetricQueries } from "../../src/metrics/metric-queries.js";
import { MetricRetention } from "../../src/metrics/metric-retention.js";
import { type MetricSource, SEGMENT_POINTS, TaskMetrics } from "../../src/metrics/task-metrics.js";
import { ApiClient } from "../../test/support/api-client.js";
import { FakeAgent } from "../../test/support/fake-agent.js";
import { publishPackage } from "../../test/support/package-archive.js";
import { runSecretsOf } from "../../test/support/run-secrets.js";
import {
	startTestControlPlane,
	type TestControlPlane,
} from "../../test/support/test-control-plane.js";
import { CHART_SERIES } from "../targets.js";

const AGENT = "bench-agent";
const METRICS = Array.from({ length: 10 }, (_, i) => `m${i}`);
const LABELED_METRICS = ["cpu_by_process", "rss_by_process", "fds_by_process", "io_by_process"];
const PROCESSES = Array.from({ length: 50 }, (_, p) => ({
	pid: String(1000 + p),
	name: `worker-${p}`,
}));
/** 带标签的节点每秒一批里的序列：每个指标 × 每个进程。 */
const LABELED_SERIES = LABELED_METRICS.flatMap((name) =>
	PROCESSES.map((labels) => ({ name, labels })),
);
const QUERY_SECONDS = 3600;
const RUN = { time: 3000, warmupTime: 500 };
// 带标签的变体每次迭代要几百毫秒到两秒：不按默认的至少 64 次（预热至少 16 次），跑满时间且至少 10 次（预热 2 次）即可。
const LABELED_RUN = { ...RUN, iterations: 10, warmupIterations: 2 };

interface BenchTask {
	/** 每秒一批里的序列。 */
	series: ReadonlyArray<{ name: string; labels?: Record<string, string> }>;
	taskId: string;
	attempt: number;
	runId: string;
	chainInstanceId: string;
}

let cp: TestControlPlane;
let agent: FakeAgent;
let database: Database;
let metrics: TaskMetrics;
let queries: MetricQueries;
let writeTask: BenchTask;
let queryTask: BenchTask;
let labeledWriteTask: BenchTask;
let labeledQueryTask: BenchTask;
/** 当前时钟（测试控制面的手动时钟，不前进）的 Unix 秒。 */
let now: number;
/** 批次的来源：时钟与控制面一致的 Agent 连接，单调时钟读数 = Unix 毫秒。 */
let source: MetricSource;

/** 一个任务在第 t 秒（Unix 秒）的一批：每个序列一个点，与 Agent 每秒发出的合并结果相同。 */
const batch = (task: BenchTask, t: number) =>
	create(MetricBatchSchema, {
		taskId: task.taskId,
		attempt: task.attempt,
		points: task.series.map(({ name, labels }, i) => {
			const value = Math.sin(t / 60 + i) * 100;
			return {
				name,
				labels,
				timeUnixS: BigInt(t),
				monotonicMs: BigInt(t * 1000),
				value,
				min: value - 1,
				max: value + 1,
			};
		}),
	});

/** 从第 from 秒起接收 seconds 秒的批次（每秒一批，按顺序）。 */
const ingest = async (task: BenchTask, from: number, seconds: number) => {
	for (let t = from; t < from + seconds; t++) await metrics.ingest(source, batch(task, t));
};

const startTask = async (
	api: ApiClient,
	orchestrationId: string,
	series: BenchTask["series"],
): Promise<BenchTask> => {
	const runId = await api.triggerOk(orchestrationId);
	const assign = await agent.nextAssign();
	const [row] = await database.db
		.select({ chainInstanceId: tasks.chainInstanceId })
		.from(tasks)
		.where(eq(tasks.id, assign.taskId));
	if (!row) throw new Error(`任务 ${assign.taskId} 不存在`);
	return {
		series,
		taskId: assign.taskId,
		attempt: assign.attempt,
		runId,
		chainInstanceId: row.chainInstanceId,
	};
};

beforeAll(async () => {
	cp = await startTestControlPlane();
	const api = new ApiClient(cp);
	await publishPackage(cp, "bench", "1.0.0", {
		load: {
			outputs: [],
			metrics: METRICS.map((name) => ({ name, unit: "", kind: "gauge" as const })),
		},
		load_labeled: {
			outputs: [],
			metrics: LABELED_METRICS.map((name) => ({
				name,
				unit: "",
				kind: "gauge" as const,
				labels: ["pid", "name"],
			})),
		},
	});
	agent = await FakeAgent.connect(cp.grpcUrl, { name: AGENT });
	// 两个编排各一个节点（节点 ID 都是 load），分别用不带标签和带标签的节点类型。
	const orchestrationOf = (node: string) =>
		api.orchestrationWith({
			default_agent: AGENT,
			nodes: [
				{ id: "entry", kind: "entry" },
				{ id: "load", kind: "package", package: "bench", node },
			],
			edges: [{ from: "entry", to: "load", kind: "chain" }],
			packages: { bench: "1.0.0" },
		});
	const plain = await orchestrationOf("load");
	const labeled = await orchestrationOf("load_labeled");
	const plainSeries = METRICS.map((name) => ({ name }));
	database = openDatabase(cp.database.url, () => {});
	const retention = new MetricRetention({ db: database.db, clock: cp.clock });
	// 上限放宽：写入基准会接收几十万个点。
	const logs = new TaskLogs({
		db: database.db,
		clock: cp.clock,
		dataDir: cp.dataDir,
		runSecrets: await runSecretsOf(cp.dataDir),
	});
	metrics = new TaskMetrics({
		db: database.db,
		clock: cp.clock,
		retention,
		secrets: (runId) => logs.runSecrets(runId),
		limitBytes: Number.MAX_SAFE_INTEGER,
	});
	queries = new MetricQueries({ db: database.db, clock: cp.clock, metrics });
	const startedAt = cp.clock.now();
	now = Math.floor(startedAt.getTime() / 1000);
	const reading = { agentTimeMs: startedAt.getTime(), monotonicMs: startedAt.getTime() };
	source = { name: AGENT, clock: new ConnectionClock(cp.clock, reading, startedAt) };

	writeTask = await startTask(api, plain, plainSeries);
	queryTask = await startTask(api, plain, plainSeries);
	labeledWriteTask = await startTask(api, labeled, LABELED_SERIES);
	labeledQueryTask = await startTask(api, labeled, LABELED_SERIES);
	// 查询用的数据：两天前的 1 小时，全部写库（内存里没有尚未写入的点）。
	for (const task of [queryTask, labeledQueryTask]) {
		await ingest(task, now - 2 * 86_400, QUERY_SECONDS);
		await metrics.flushTask(task.taskId);
	}
}, 600_000);

afterAll(async () => {
	await agent?.disconnect();
	await database?.close();
	await cp?.close();
});

/** 一天前起，每次迭代接着上一次的时间往后写 120 秒（同一序列的点不能重复）。 */
const segmentWrite = (task: BenchTask) => {
	let next = now - 86_400;
	return async () => {
		await ingest(task, next, SEGMENT_POINTS);
		next += SEGMENT_POINTS;
	};
};

test("指标分段写入", async ({ bench }) => {
	await bench("segment_write", segmentWrite(writeTask)).run(RUN);
});

test("带标签的指标分段写入", async ({ bench }) => {
	await bench("segment_write_labeled", segmentWrite(labeledWriteTask)).run(LABELED_RUN);
});

/**
 * 一个任务的序列查询（`metrics` 不给时查节点的全部指标）；先核对一次数据完整：序列个数对得上，
 * 每个序列的桶里合计 3600 个点。
 */
const seriesQuery = async (
	task: BenchTask,
	checkPoints: readonly number[],
	metrics?: readonly string[],
) => {
	const query = async (points: number) => {
		const outcome = await queries.series(task.runId, {
			chain_instance_id: task.chainInstanceId,
			node_id: "load",
			points,
			...(metrics && { metrics: [...metrics] }),
		});
		if (!outcome.ok) throw new Error(outcome.message);
		return outcome.series;
	};
	const expected = metrics
		? task.series.filter((s) => metrics.includes(s.name)).length
		: task.series.length;
	for (const points of checkPoints) {
		const result = await query(points);
		if (result.series.length !== expected) {
			throw new Error(`只查到 ${result.series.length} 个序列`);
		}
		for (const s of result.series) {
			const total = s.buckets.reduce((n, b) => n + b.points, 0);
			if (total !== QUERY_SECONDS) throw new Error(`${s.name} 只查到 ${total} 个点`);
		}
	}
	return query;
};

test("降采样查询", async ({ bench }) => {
	const query = await seriesQuery(queryTask, [300, 12]);
	await bench("query_300", () => query(300)).run(RUN);
	await bench("query_12", () => query(12)).run(RUN);
});

test("带标签的降采样查询", async ({ bench }) => {
	const query = await seriesQuery(labeledQueryTask, [300]);
	await bench("query_300_labeled", () => query(300)).run(LABELED_RUN);
});

test("一张图表的带标签降采样查询", async ({ bench }) => {
	const one = await seriesQuery(labeledQueryTask, [300], LABELED_METRICS.slice(0, 1));
	// docs/ARCHITECTURE.md §7.6「运行监控页的图表」的规模：CHART_SERIES 个序列，即这么多个带标签指标 × 50 个进程。
	const two = await seriesQuery(
		labeledQueryTask,
		[300],
		LABELED_METRICS.slice(0, CHART_SERIES / PROCESSES.length),
	);
	await bench("query_300_chart_50", () => one(300)).run(LABELED_RUN);
	await bench("query_300_chart_100", () => two(300)).run(LABELED_RUN);
});

test("关注项读数的序列查询（带最近点的时间）", async ({ bench }) => {
	const read = (task: BenchTask, names: readonly string[], points: number, recent: boolean) => () =>
		queries.taskSeries(
			task.taskId,
			{
				declared: names.map((name) => ({
					name,
					unit: "",
					kind: "gauge" as const,
					...(task === labeledQueryTask && { labels: ["pid", "name"] }),
				})),
				names,
				expired: false,
				points,
				...(recent && { recent: SAMPLE_POINTS }),
			},
			database.db,
		);
	const chart = LABELED_METRICS.slice(0, CHART_SERIES / PROCESSES.length);
	// 先核对一次：每个序列都读到了最近 10 个点的时间，每秒一个。
	for (const [task, names] of [
		[queryTask, METRICS],
		[labeledQueryTask, chart],
	] as const) {
		const { series } = await read(task, names, 1, true)();
		for (const s of series) {
			const last = s.recent.at(-1) ?? 0;
			if (s.recent.length !== SAMPLE_POINTS || last - (s.recent[0] ?? 0) !== SAMPLE_POINTS - 1) {
				throw new Error(`${s.name} 最近的点不对：${s.recent.join(",")}`);
			}
		}
	}
	await bench("focus_1", read(queryTask, METRICS, 1, false)).run(RUN);
	await bench("focus_1_recent", read(queryTask, METRICS, 1, true)).run(RUN);
	await bench("focus_60_chart_100", read(labeledQueryTask, chart, 60, false)).run(LABELED_RUN);
	await bench("focus_60_chart_100_recent", read(labeledQueryTask, chart, 60, true)).run(
		LABELED_RUN,
	);
});

/** 同一时刻有 n 个读在途，共 batches 批。 */
const concurrently = (read: () => Promise<unknown>, n: number) => async () => {
	await Promise.all(Array.from({ length: n }, read));
};

/**
 * 当前库的累计访问量（pg_stat_database）。各连接空闲时才把统计刷出来，刚刷过的连接要等 10 秒（PGSTAT_IDLE_INTERVAL）
 * 才会再刷一次：读之前等够，前面的迭代才不会算进这一段里。
 */
const dbCounters = async () => {
	await new Promise((resolve) => setTimeout(resolve, 11_000));
	const { rows } = await database.db.execute(sql`
		SELECT blks_hit + blks_read AS blocks, blks_read AS disk_blocks, tup_returned AS returned,
		       tup_fetched AS fetched, xact_commit AS xacts
		FROM pg_stat_database WHERE datname = current_database()`);
	const row = rows[0] as Record<string, string>;
	return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)]));
};

test("关注项读数的并发读（8、32 个并发，带与不带最近点的时间）", async ({ bench }) => {
	const read = (task: BenchTask, names: readonly string[], points: number, recent: boolean) => () =>
		queries.taskSeries(
			task.taskId,
			{
				declared: names.map((name) => ({
					name,
					unit: "",
					kind: "gauge" as const,
					...(task === labeledQueryTask && { labels: ["pid", "name"] }),
				})),
				names,
				expired: false,
				points,
				...(recent && { recent: SAMPLE_POINTS }),
			},
			database.db,
		);
	const chart = LABELED_METRICS.slice(0, CHART_SERIES / PROCESSES.length);
	const shapes = [
		{ id: "1", task: queryTask, names: METRICS, points: 1, run: RUN },
		{ id: "chart_100", task: labeledQueryTask, names: chart, points: 60, run: LABELED_RUN },
	] as const;
	const DB_BATCHES = 20;
	for (const shape of shapes) {
		for (const n of [8, 32]) {
			for (const recent of [false, true]) {
				const name = `focus_c${n}_${shape.id}${recent ? "_recent" : ""}`;
				const batch = concurrently(read(shape.task, shape.names, shape.points, recent), n);
				await bench(name, batch).run(shape.run);
				const before = await dbCounters();
				for (let i = 0; i < DB_BATCHES; i++) await batch();
				const after = await dbCounters();
				const per = (k: string) =>
					(((after[k] ?? 0) - (before[k] ?? 0)) / (n * DB_BATCHES)).toFixed(1);
				console.log(
					`[focus-db] ${name} 每次读：访问 ${per("blocks")} 个块（读盘 ${per("disk_blocks")}），返回 ${per("returned")} 行，取 ${per("fetched")} 行，${per("xacts")} 个事务`,
				);
			}
		}
	}
}, 900_000);
