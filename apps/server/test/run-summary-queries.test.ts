// 切入点 B：运行摘要的查询次数与节点数无关（#423）。摘要接口用只有一个连接的数据库读（`singleConnection`），数这次读发出的
// 查询：节点多得多、失败的尝试也多得多的运行，查询次数和小运行一样；查询一条接一条地执行，不在同一个连接上并发。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskLogs } from "../src/logs/task-logs.js";
import { MetricQueries } from "../src/metrics/metric-queries.js";
import { MetricRetention } from "../src/metrics/metric-retention.js";
import { TaskMetrics } from "../src/metrics/task-metrics.js";
import { buildRunReport } from "../src/runs/run-summary.js";
import { ApiClient } from "./support/api-client.js";
import { FakeAgent } from "./support/fake-agent.js";
import { benchDocument, publishBench, putFocusItemsOk } from "./support/focus-items.js";
import { runSecretsOf } from "./support/run-secrets.js";
import { singleConnection } from "./support/single-connection.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

describe("运行摘要的查询次数", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let agent: FakeAgent;

	beforeEach(async () => {
		cp = await startTestControlPlane({ leaseMs: 60 * 60_000 });
		api = new ApiClient(cp);
		await publishBench(cp);
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 4 }, { clock: cp.clock });
	});
	afterEach(async () => {
		await agent.disconnect();
		await cp.close();
	});

	/**
	 * `count` 个探针节点串成一条链：前面的都成功，最后一个节点（重试 `retries` 次）每次都失败；场景设了两个关注项。
	 * 返回运行 ID。
	 */
	async function failingRun(count: number, retries: number): Promise<string> {
		const nodes = Array.from({ length: count }, (_, i): [string, string] => [`n${i + 1}`, "probe"]);
		const document = benchDocument(nodes);
		const last = document.nodes.at(-1);
		if (last) Object.assign(last, { retries });
		const id = await api.orchestrationWith(document);
		await putFocusItemsOk(api, id, [
			{ node_id: "n1", chart: "level" },
			{ node_id: `n${count}`, chart: "level" },
		]);
		const runId = await api.triggerOk(id);
		for (let i = 1; i < count; i++) await agent.succeed(await agent.nextAssign());
		for (let attempt = 0; attempt <= retries; attempt++) {
			await agent.fail(await agent.nextAssign(), `失败 ${attempt + 1}`);
		}
		return runId;
	}

	it("节点和失败的尝试多得多的运行，读摘要的查询次数不变，查询一条接一条地执行", async () => {
		const small = await failingRun(2, 0);
		const big = await failingRun(24, 4);

		const single = singleConnection(cp.database.url);
		try {
			const { db } = single;
			const clock = cp.clock;
			const logs = new TaskLogs({
				db,
				clock,
				dataDir: cp.dataDir,
				runSecrets: await runSecretsOf(cp.dataDir),
			});
			const deps = {
				db,
				clock,
				queries: new MetricQueries({
					db,
					clock,
					metrics: new TaskMetrics({
						db,
						clock,
						retention: new MetricRetention({ db, clock }),
						secrets: (runId) => logs.runSecrets(runId),
					}),
				}),
				logs,
			};
			const counted = async (runId: string) => {
				const before = single.queryCount();
				const report = await buildRunReport(deps, runId);
				return { report, queries: single.queryCount() - before };
			};

			const first = await counted(small);
			const second = await counted(big);

			expect(first.report?.failed_tasks_total).toBe(1);
			expect(second.report?.failed_tasks_total).toBe(5);
			// 24 个探针节点加入口节点。
			expect(second.report?.chains.flatMap((c) => c.nodes)).toHaveLength(25);
			expect(second.queries).toBe(first.queries);
			// 运行的读取、日志文件概况、动作摘要、关注项读数：个数是固定的，不随运行的大小增长。
			expect(first.queries).toBeLessThanOrEqual(12);
			expect(single.mostPending()).toBe(1);
		} finally {
			await single.end();
		}
	});
});
