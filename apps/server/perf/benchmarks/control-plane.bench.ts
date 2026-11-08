// 基准测试（ARCHITECTURE §7.6）：控制面的指标分段写入与降采样查询耗时（vitest bench）。只在本地运行，不进 CI：
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
//   × 50 个进程，共 200 个序列（按进程上报的节点，例如标准节点 process_monitor）：一次写入迭代 = 24000 个点、
//   200 段；查询的数据是 1 小时 × 200 个序列（72 万个点）。
import { create } from "@bufbuild/protobuf";
import { MetricBatchSchema } from "@sfly/proto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, test } from "vitest";
import { type Database, openDatabase } from "../../src/db/database.js";
import { tasks } from "../../src/db/schema.js";
import { MetricQueries } from "../../src/metrics/metric-queries.js";
import { MetricRetention } from "../../src/metrics/metric-retention.js";
import { SEGMENT_POINTS, TaskMetrics } from "../../src/metrics/task-metrics.js";
import { ApiClient } from "../../test/support/api-client.js";
import { FakeAgent } from "../../test/support/fake-agent.js";
import { publishPackage } from "../../test/support/package-archive.js";
import {
	startTestControlPlane,
	type TestControlPlane,
} from "../../test/support/test-control-plane.js";

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

/** 一个任务在第 t 秒（Unix 秒）的一批：每个序列一个点，与 Agent 每秒发出的合并结果相同。 */
const batch = (task: BenchTask, t: number) =>
	create(MetricBatchSchema, {
		taskId: task.taskId,
		attempt: task.attempt,
		points: task.series.map(({ name, labels }, i) => {
			const value = Math.sin(t / 60 + i) * 100;
			return { name, labels, timeUnixS: BigInt(t), value, min: value - 1, max: value + 1 };
		}),
	});

/** 从第 from 秒起接收 seconds 秒的批次（每秒一批，按顺序）。 */
const ingest = async (task: BenchTask, from: number, seconds: number) => {
	for (let t = from; t < from + seconds; t++) await metrics.ingest(AGENT, batch(task, t));
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
	metrics = new TaskMetrics({
		db: database.db,
		clock: cp.clock,
		retention,
		limitBytes: Number.MAX_SAFE_INTEGER,
	});
	queries = new MetricQueries({ db: database.db, clock: cp.clock, metrics });
	now = Math.floor(cp.clock.now().getTime() / 1000);

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

/** 一个任务的序列查询；先核对一次数据完整：每个序列的桶里合计 3600 个点。 */
const seriesQuery = async (task: BenchTask, checkPoints: readonly number[]) => {
	const query = async (points: number) => {
		const outcome = await queries.series(task.runId, {
			chain_instance_id: task.chainInstanceId,
			node_id: "load",
			points,
		});
		if (!outcome.ok) throw new Error(outcome.message);
		return outcome.series;
	};
	for (const points of checkPoints) {
		const result = await query(points);
		if (result.series.length !== task.series.length) {
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
