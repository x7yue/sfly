// 切入点 A：指标保留期与分区维护（#32）。周期扫描提前创建未来的分区、删除整天过期的分区；
// 是否到期只按注入的时钟判断：测试推进 ManualClock，周期扫描（间隔 20ms）很快就会处理。
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import type { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const DAY = 24 * 60 * 60 * 1000;

const ORCHESTRATION = {
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry" },
		{ id: "load", kind: "package", package: "bench", node: "load" },
	],
	edges: [{ from: "entry", to: "load", kind: "chain" }],
	packages: { bench: "1.0.0" },
};

describe("指标保留期与分区维护", () => {
	let cp: TestControlPlane;
	let agent: FakeAgent;

	afterEach(async () => {
		await agent.disconnect();
		await cp.close();
	});

	const setup = async (
		options: Omit<Parameters<typeof startTestControlPlane>[0] & object, "clock"> = {},
	) => {
		// 时钟一次推进几十天：任务租约设得更长，免得没有心跳的假 Agent 的任务以 agent_lost 结束。
		cp = await startTestControlPlane({ leaseMs: 400 * DAY, ...options });
		await publishPackage(cp, "bench", "1.0.0", {
			load: { outputs: [], metrics: [{ name: "tps", unit: "req/s", kind: "gauge" }] },
		});
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
		return new ApiClient(cp);
	};
	const clock = () => cp.clock as ManualClock;
	/** 当前时钟之后第 s 秒（Unix 秒）。 */
	const now = (s = 0) => Math.floor(clock().now().getTime() / 1000) + s;

	/** 分区本身就是这条验收标准的可观察结果，所以直接查数据库：metric_segments 的分区名（按名字排序）。 */
	const query = async <R extends object>(text: string): Promise<R[]> => {
		const client = new pg.Client({ connectionString: cp.database.url });
		await client.connect();
		try {
			return (await client.query<R>(text)).rows;
		} finally {
			await client.end();
		}
	};
	const partitions = async (): Promise<string[]> =>
		(
			await query<{ name: string }>(
				`select c.relname as name from pg_inherits i
					join pg_class c on c.oid = i.inhrelid join pg_class p on p.oid = i.inhparent
				where p.relname = 'metric_segments' order by 1`,
			)
		).map((r) => r.name);

	it("周期扫描提前创建今天和之后两天的分区，随时钟推进继续创建", async () => {
		await setup();
		await eventually(async () =>
			expect(await partitions()).toEqual([
				"metric_segments_20260101",
				"metric_segments_20260102",
				"metric_segments_20260103",
			]),
		);

		clock().advance(DAY);
		await eventually(async () => expect(await partitions()).toContain("metric_segments_20260104"));
	});

	it("整天都超过保留期（可配置）的分区被删除", async () => {
		const api = await setup({ metricRetentionDays: 7 });
		const runId = await api.triggerOk(await api.orchestrationWith(ORCHESTRATION));
		const task = await agent.nextAssign();
		agent.metrics(task, [["tps", now(1), 10]]);
		await agent.succeed(task);
		await eventually(async () => expect(await partitions()).toContain("metric_segments_20260101"));

		// 2026-01-01 这一天的分区要到 01-02 00:00 之后再过 7 天才整天过期。
		clock().set(new Date(Date.UTC(2026, 0, 9) - 1000));
		await eventually(async () => expect(await partitions()).toContain("metric_segments_20260110"));
		expect(await partitions()).toContain("metric_segments_20260101");

		clock().advance(2000);
		await eventually(async () =>
			expect(await partitions()).not.toContain("metric_segments_20260101"),
		);
		expect(await partitions()).toContain("metric_segments_20260102");
		expect((await cp.fetch(`/runs/${runId}/metrics/summary`)).status).toBe(200);
	});

	const summary = async (runId: string) => {
		const res = await cp.fetch(`/runs/${runId}/metrics/summary`);
		expect(res.status).toBe(200);
		return (await res.json()) as { run_id: string; expired: boolean; tasks: unknown[] };
	};
	/** 触发一次运行，任务上报一个点；finish 时上报成功（运行结束），否则推进时钟让点写库。 */
	const runWithMetrics = async (api: ApiClient, finish = true) => {
		const runId = await api.triggerOk(await api.orchestrationWith(ORCHESTRATION));
		const task = await agent.nextAssign();
		agent.metrics(task, [["tps", now(1), 10]]);
		if (finish) await agent.succeed(task);
		else {
			await agent.sync();
			clock().advance(10_000);
		}
		await eventually(async () => expect((await summary(runId)).tasks).toHaveLength(1));
		return runId;
	};
	/** 等几轮扫描（间隔 20ms），用来断言"没有过期"。 */
	const fewSweeps = () => new Promise((r) => setTimeout(r, 150));

	it("运行结束超过指标保留期后，摘要接口返回“已过保留期”，不报错", async () => {
		const api = await setup({ metricRetentionDays: 7 });
		const runId = await runWithMetrics(api);
		expect(await summary(runId)).toMatchObject({ run_id: runId, expired: false });

		clock().advance(7 * DAY - 1000);
		await fewSweeps();
		expect((await summary(runId)).expired).toBe(false);

		clock().advance(2000);
		await eventually(async () =>
			expect(await summary(runId)).toEqual({ run_id: runId, expired: true, tasks: [] }),
		);
		// 整天过期的分区删除之后依然如此。
		clock().advance(2 * DAY);
		await eventually(async () =>
			expect(await partitions()).not.toContain("metric_segments_20260101"),
		);
		expect(await summary(runId)).toEqual({ run_id: runId, expired: true, tasks: [] });
	});

	it("默认保留 30 天，与日志和产物的保留期分开；还在运行的运行不算过期", async () => {
		const api = await setup({ retentionDays: 1 });
		const done = await runWithMetrics(api);
		const running = await runWithMetrics(api, false);

		clock().advance(30 * DAY - 20_000);
		await fewSweeps();
		expect((await summary(done)).expired).toBe(false);
		expect((await summary(done)).tasks).toHaveLength(1);

		clock().advance(30_000);
		await eventually(async () => expect((await summary(done)).expired).toBe(true));
		expect(await summary(running)).toMatchObject({ expired: false, tasks: [expect.anything()] });
	});

	it("控制面重启后，按数据库里的结束时间照常判断过期", async () => {
		const api = await setup({ metricRetentionDays: 1 });
		const runId = await runWithMetrics(api);
		await agent.disconnect();
		await cp.restart(() => clock().advance(DAY + 1000));
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
		await eventually(async () => expect((await summary(runId)).expired).toBe(true));
	});

	const tpsOf = async (runId: string) =>
		((await summary(runId)).tasks[0] as { metrics: Array<{ points: number; last: number }> })
			?.metrics[0];

	it("时间戳超出合理范围的点被丢弃，不按异常的日期建分区", async () => {
		const api = await setup();
		const runId = await api.triggerOk(await api.orchestrationWith(ORCHESTRATION));
		const task = await agent.nextAssign();
		agent.metrics(task, [
			["tps", 0, 1],
			["tps", now(-31 * 86_400), 2],
			// 保留期内、还没有分区的过去日期（例如 Agent 断线期间排队的点）：按需创建。
			["tps", now(-10 * 86_400), 3],
			["tps", now(1), 4],
			// 超出提前创建的分区（2026-01-01 到 01-03）。
			["tps", now(3 * 86_400), 5],
			["tps", Date.UTC(2099, 0, 1) / 1000, 6],
			["tps", now(2), 7],
		]);
		await agent.succeed(task);

		expect(await tpsOf(runId)).toMatchObject({ points: 3, last: 7 });
		expect(await partitions()).toEqual([
			"metric_segments_20251222",
			"metric_segments_20260101",
			"metric_segments_20260102",
			"metric_segments_20260103",
		]);
	});

	it("分区被别处删除后，写入时重新创建", async () => {
		const api = await setup();
		const runId = await api.triggerOk(await api.orchestrationWith(ORCHESTRATION));
		const task = await agent.nextAssign();
		agent.metrics(task, [["tps", now(1), 1]]);
		await agent.sync();
		clock().advance(10_000);
		await eventually(async () => expect((await tpsOf(runId))?.points).toBe(1));

		await query("drop table metric_segments_20260101");
		agent.metrics(task, [["tps", now(1), 2]]);
		await agent.succeed(task);
		expect(await tpsOf(runId)).toMatchObject({ points: 2, last: 2 });
		expect(await partitions()).toContain("metric_segments_20260101");
	});
});
