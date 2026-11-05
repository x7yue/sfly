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
	const partitions = async (): Promise<string[]> => {
		const client = new pg.Client({ connectionString: cp.database.url });
		await client.connect();
		try {
			const { rows } = await client.query<{ name: string }>(
				`select c.relname as name from pg_inherits i
					join pg_class c on c.oid = i.inhrelid join pg_class p on p.oid = i.inhparent
				where p.relname = 'metric_segments' order by 1`,
			);
			return rows.map((r) => r.name);
		} finally {
			await client.end();
		}
	};

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
});
