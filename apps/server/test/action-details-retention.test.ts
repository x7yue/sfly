// 切入点 A：动作的保留期（规格 #345，#357）。保留期和日志相同：运行结束超过保留期后，它的明细、每种名称的计数和摘要
// 一起删除，接口返回「已过保留期」。是否到期只按注入的时钟判断：测试推进 ManualClock，周期扫描很快就会处理。
import { actionsApi } from "@sfly/schema";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import type { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { SseClient } from "./support/sse-client.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-01-01T00:00:00.000Z");

const DOC = {
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry" },
		{ id: "a", kind: "package", package: "stub", node: "echo" },
	],
	edges: [{ from: "entry", to: "a", kind: "chain" }],
	packages: { stub: "1.0.0" },
};

describe("动作的保留期", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let agent: FakeAgent;
	const streams: SseClient[] = [];

	beforeEach(async () => {
		// 时钟一次推进几天：任务租约设得更长，免得没有心跳的假 Agent 的任务以 agent_lost 结束。
		cp = await startTestControlPlane({ leaseMs: 400 * DAY, retentionDays: 7 });
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" }, { clock: cp.clock });
	});
	afterEach(async () => {
		for (const s of streams.splice(0)) s.close();
		await agent.disconnect();
		await cp.close();
	});

	const page = async (taskId: string) =>
		actionsApi.page.response.parse(await (await cp.fetch(`/tasks/${taskId}/actions`)).json());
	/** 存储不再增长就是这条验收标准的可观察结果，所以直接查数据库：三张表里这个任务还剩几行。 */
	const storedRows = async (taskId: string) => {
		const client = new pg.Client({ connectionString: cp.database.url });
		await client.connect();
		try {
			const counts: number[] = [];
			for (const table of ["task_actions", "task_action_names", "task_action_summaries"]) {
				const { rows } = await client.query<{ n: string }>(
					`select count(*) as n from ${table} where task_id = $1`,
					[taskId],
				);
				counts.push(Number(rows[0]?.n));
			}
			return counts;
		} finally {
			await client.end();
		}
	};

	it("运行结束超过保留期后，明细、每种名称的计数和摘要都被删除，明细接口返回已过保留期，实时推送只发摘要", async () => {
		await api.triggerOk(await api.orchestrationWith(DOC));
		const task = await agent.nextAssign();
		agent.actions(task, [
			agent.actionStart(1, "下单", T0 + 1_000),
			agent.actionEnd(1, "success", T0 + 1_100),
			agent.actionMark(2, "开盘", T0 + 1_200),
		]);
		agent.actionSummary(task, { total: 2, marks: 1, reported: 2 });
		await agent.sync();
		await agent.succeed(task);
		expect((await page(task.taskId)).actions).toHaveLength(2);
		expect(await storedRows(task.taskId)).toEqual([2, 2, 1]);

		(cp.clock as ManualClock).advance(7 * DAY + 1_000);
		await eventually(async () => expect((await page(task.taskId)).expired).toBe(true));
		expect(await page(task.taskId)).toEqual({
			task_id: task.taskId,
			actions: [],
			before: null,
			count_only: [],
			rev: 1,
			expired: true,
		});
		expect(await storedRows(task.taskId)).toEqual([0, 0, 0]);

		const sse = await SseClient.open(cp, `/tasks/${task.taskId}/actions/events`);
		streams.push(sse);
		await sse.next("summary");
		await sse.expectNone(100);
	});
});
