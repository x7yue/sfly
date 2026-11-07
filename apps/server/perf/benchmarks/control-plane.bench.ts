// 基准测试（ARCHITECTURE §7.6）：控制面的指标分段写入与降采样查询耗时（vitest bench）。只在本地运行，不进 CI：
// `vitest run` 只选 test/**/*.test.ts，基准测试只在 `vitest bench` 下运行；`pnpm perf` 顺带运行并汇总进报告
// （perf/items/09-bench-control-plane.ts）。需要本机 PostgreSQL（与控制面测试相同，DATABASE_URL）。
//
// 单独运行：`pnpm --filter @sfly/server exec vitest bench --run perf/benchmarks/control-plane.bench.ts`
//
// 直接驱动 TaskMetrics / MetricQueries（src/metrics），不经过 gRPC 与 HTTP：测的是写入与查询本身。
// 任务、编排与节点包声明经由测试用控制面和假 Agent 正常创建（与控制面测试相同）。
//
// - segment_write：一个任务 10 个指标，按 Agent 的节奏每秒一批（每个指标一个点）接收 120 秒——
//   最后一批让 10 段同时攒满，在一个事务里整段写入（ADR 0009）；一次迭代 = 1200 个点。
// - query_300 / query_12：1 小时、10 个指标（36000 个点，全部已写库）的序列查询，分别降采样到
//   300 个桶（运行页面的默认值，段跨多个桶，要展开数组）和 12 个桶（多数段落在一个桶里，直接用段摘要）。
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
const QUERY_SECONDS = 3600;
const RUN = { time: 3000, warmupTime: 500 };

interface BenchTask {
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
/** 当前时钟（测试控制面的手动时钟，不前进）的 Unix 秒。 */
let now: number;

/** 一个任务在第 t 秒（Unix 秒）的一批：每个指标一个点，与 Agent 每秒发出的合并结果相同。 */
const batch = (task: BenchTask, t: number) =>
	create(MetricBatchSchema, {
		taskId: task.taskId,
		attempt: task.attempt,
		points: METRICS.map((name, i) => {
			const value = Math.sin(t / 60 + i) * 100;
			return { name, timeUnixS: BigInt(t), value, min: value - 1, max: value + 1 };
		}),
	});

/** 从第 from 秒起接收 seconds 秒的批次（每秒一批，按顺序）。 */
const ingest = async (task: BenchTask, from: number, seconds: number) => {
	for (let t = from; t < from + seconds; t++) await metrics.ingest(AGENT, batch(task, t));
};

const startTask = async (api: ApiClient, orchestrationId: string): Promise<BenchTask> => {
	const runId = await api.triggerOk(orchestrationId);
	const assign = await agent.nextAssign();
	const [row] = await database.db
		.select({ chainInstanceId: tasks.chainInstanceId })
		.from(tasks)
		.where(eq(tasks.id, assign.taskId));
	if (!row) throw new Error(`任务 ${assign.taskId} 不存在`);
	return {
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
	});
	agent = await FakeAgent.connect(cp.grpcUrl, { name: AGENT });
	const orchestrationId = await api.orchestrationWith({
		default_agent: AGENT,
		nodes: [
			{ id: "entry", kind: "entry" },
			{ id: "load", kind: "package", package: "bench", node: "load" },
		],
		edges: [{ from: "entry", to: "load", kind: "chain" }],
		packages: { bench: "1.0.0" },
	});
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

	writeTask = await startTask(api, orchestrationId);
	queryTask = await startTask(api, orchestrationId);
	// 查询用的数据：两天前的 1 小时，全部写库（内存里没有尚未写入的点）。
	await ingest(queryTask, now - 2 * 86_400, QUERY_SECONDS);
	await metrics.flushTask(queryTask.taskId);
}, 300_000);

afterAll(async () => {
	await agent?.disconnect();
	await database?.close();
	await cp?.close();
});

test("指标分段写入", async ({ bench }) => {
	// 一天前起，每次迭代接着上一次的时间往后写 120 秒（同一指标的点不能重复）。
	let next = now - 86_400;
	await bench("segment_write", async () => {
		await ingest(writeTask, next, SEGMENT_POINTS);
		next += SEGMENT_POINTS;
	}).run(RUN);
});

test("降采样查询", async ({ bench }) => {
	const query = async (points: number) => {
		const outcome = await queries.series(queryTask.runId, {
			chain_instance_id: queryTask.chainInstanceId,
			node_id: "load",
			points,
		});
		if (!outcome.ok) throw new Error(outcome.message);
		return outcome.series;
	};
	// 先核对一次数据完整：每个指标的桶里合计 3600 个点。
	for (const points of [300, 12]) {
		const series = await query(points);
		for (const s of series.series) {
			const total = s.buckets.reduce((n, b) => n + b.points, 0);
			if (total !== QUERY_SECONDS) throw new Error(`${s.name} 只查到 ${total} 个点`);
		}
	}
	await bench("query_300", () => query(300)).run(RUN);
	await bench("query_12", () => query(12)).run(RUN);
});
