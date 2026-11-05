// 切入点 A：跨场景的运行列表（运行记录页，契约 runListApi）。
// HTTP API + 讲真实 gRPC 的假 Agent + 真实 PostgreSQL。
import { runListApi } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { type AssignedTask, FakeAgent } from "./support/fake-agent.js";
import type { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

type Node = Record<string, unknown> & { id: string };

const echo = (id: string): Node => ({ id, kind: "package", package: "stub", node: "echo" });
const entry: Node = { id: "entry", kind: "entry", params: [] };

/** 由若干条链组成的场景文档：每条链按顺序排列（第一个是起点）；dispatch 为 [异步任务节点, 子流程入口]。 */
function orchestration(chains: Node[][], dispatch: Array<[string, string]> = []) {
	return {
		default_agent: "agent-a",
		nodes: chains.flat(),
		edges: [
			...chains.flatMap((c) =>
				c.slice(1).map((n, i) => ({ from: c[i]?.id, to: n.id, kind: "chain" })),
			),
			...dispatch.map(([from, to]) => ({ from, to, kind: "dispatch" })),
		],
		packages: { stub: "1.0.0" },
	};
}

describe("跨场景的运行列表", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let agent: FakeAgent;
	let clock: ManualClock;

	beforeEach(async () => {
		cp = await startTestControlPlane();
		clock = cp.clock as ManualClock;
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 8 });
	});
	afterEach(async () => {
		await agent.disconnect();
		await cp.close();
	});

	async function list(query = "") {
		const res = await api.get(`/runs${query}`);
		expect(res.status, await res.clone().text()).toBe(200);
		return runListApi.list.response.parse(await res.json());
	}

	/** 触发后把主链上的节点依次做完（最后一个按 last 处理）。 */
	async function runToEnd(
		scenarioId: string,
		nickname: string,
		last: (task: AssignedTask) => Promise<unknown> = (t) => agent.succeed(t),
	): Promise<string> {
		const res = await api.trigger(scenarioId, {}, nickname);
		expect(res.status).toBe(201);
		const { id } = (await res.json()) as { id: string };
		const a = await agent.nextAssign();
		await agent.succeed(a);
		await last(await agent.nextAssign());
		return id;
	}

	it("列出所有场景的运行，从新到旧，带场景名称、版本、触发人与各链节点状态", async () => {
		const checkout = await api.orchestrationWith(
			orchestration([[entry, echo("a"), echo("b")]]),
			"结账回归",
		);
		const login = await api.orchestrationWith(
			orchestration([[entry, echo("a"), echo("b")]]),
			"登录",
		);
		await api.saveVersion(login, orchestration([[entry, echo("a"), echo("b")]]));

		const first = await runToEnd(checkout, "小红");
		clock.advance(60_000);
		const second = await runToEnd(login, "小明", (t) => agent.fail(t, "断言失败"));
		clock.advance(60_000);
		const third = await api.triggerOk(login);
		await agent.nextAssign();

		const body = await list();
		expect(body.runs.map((r) => r.id)).toEqual([third, second, first]);
		expect(body.counts).toEqual({ running: 1, success: 1, failed: 1, cancelled: 0 });
		expect(body.runs[2]).toMatchObject({
			orchestration_id: checkout,
			orchestration_name: "结账回归",
			orchestration_version: 1,
			status: "success",
			cancelling: false,
			triggered_by: "小红",
			started_at: "2026-01-01T00:00:00.000Z",
			ended_at: "2026-01-01T00:00:00.000Z",
			active_nodes: [],
			failures: [],
		});
		expect(body.runs[2]?.chains).toEqual([
			{
				id: expect.any(String),
				chain_id: "entry",
				subflow: false,
				status: "success",
				nodes: [
					{ node_id: "entry", status: "success" },
					{ node_id: "a", status: "success" },
					{ node_id: "b", status: "success" },
				],
			},
		]);
		// 失败节点与运行在同一项里给出。
		expect(body.runs[1]).toMatchObject({
			orchestration_name: "登录",
			orchestration_version: 2,
			status: "failed",
			triggered_by: "小明",
			failures: [{ chain_id: "entry", subflow: false, node_id: "b" }],
		});
		expect(body.runs[0]).toMatchObject({
			status: "running",
			ended_at: null,
			active_nodes: [{ node_id: "a", status: "running", progress: null }],
		});
	});

	it("按状态、场景、运行编号前缀与触发人筛选；计数只按场景与关键字筛选", async () => {
		const checkout = await api.orchestrationWith(
			orchestration([[entry, echo("a"), echo("b")]]),
			"结账回归",
		);
		const login = await api.orchestrationWith(
			orchestration([[entry, echo("a"), echo("b")]]),
			"登录",
		);
		const ok = await runToEnd(checkout, "Alice");
		const failed = await runToEnd(checkout, "bob", (t) => agent.fail(t));
		const other = await runToEnd(login, "alice.w");

		const failedOnly = await list("?status=failed");
		expect(failedOnly.runs.map((r) => r.id)).toEqual([failed]);
		expect(failedOnly.counts).toEqual({ running: 0, success: 2, failed: 1, cancelled: 0 });

		const ofCheckout = await list(`?orchestration_id=${checkout}`);
		expect(new Set(ofCheckout.runs.map((r) => r.id))).toEqual(new Set([ok, failed]));
		expect(ofCheckout.counts).toEqual({ running: 0, success: 1, failed: 1, cancelled: 0 });

		// 触发人：包含、不区分大小写。
		const byAlice = await list("?q=ALICE");
		expect(new Set(byAlice.runs.map((r) => r.id))).toEqual(new Set([ok, other]));
		expect(byAlice.counts).toEqual({ running: 0, success: 2, failed: 0, cancelled: 0 });

		// 运行编号：前缀匹配。
		const byId = await list(`?q=${failed.slice(0, 8)}`);
		expect(byId.runs.map((r) => r.id)).toEqual([failed]);
		expect((await list(`?q=${failed.slice(4, 12)}`)).runs).toEqual([]);

		// 通配符按字面匹配。
		expect((await list("?q=%25")).runs).toEqual([]);

		const combined = await list(`?orchestration_id=${checkout}&q=alice&status=success`);
		expect(combined.runs.map((r) => r.id)).toEqual([ok]);

		// 空参数等于没给。
		expect((await list("?status=&orchestration_id=&q=")).runs).toHaveLength(3);
		expect((await list("?limit=2")).runs).toHaveLength(2);
	});

	it("进行中的运行给出正在执行的节点与进度、失败的子流程与取消中标记", async () => {
		const scenario = await api.orchestrationWith(
			orchestration(
				[
					[entry, { id: "spawn", kind: "async", params: {} }, echo("main")],
					[{ id: "sub", kind: "subflow_entry", params: [] }, echo("c")],
				],
				[["spawn", "sub"]],
			),
			"带子流程",
		);
		const runId = await api.triggerOk(scenario);
		const tasks: Record<string, AssignedTask> = {};
		for (let i = 0; i < 2; i++) {
			const task = await agent.nextAssign();
			tasks[task.nodeId] = task;
		}
		agent.progress(tasks.main as AssignedTask, 3, 10, "第 3 步");
		await agent.fail(tasks.c as AssignedTask);

		await eventually(async () => {
			const [run] = (await list()).runs;
			expect(run?.active_nodes).toEqual([
				{
					chain_instance_id: expect.any(String),
					node_id: "main",
					status: "running",
					progress: { current: 3, total: 10 },
				},
			]);
		});
		const [item] = (await list()).runs;
		expect(item).toMatchObject({ id: runId, status: "running", cancelling: false });
		expect(item?.chains.map((c) => [c.chain_id, c.subflow, c.status])).toEqual([
			["entry", false, "running"],
			["sub", true, "failed"],
		]);
		const sub = item?.chains[1];
		expect(item?.failures).toEqual([
			{ chain_instance_id: sub?.id, chain_id: "sub", subflow: true, node_id: "c" },
		]);
		expect(item?.active_nodes[0]?.chain_instance_id).toBe(item?.chains[0]?.id);

		await api.cancelOk(runId);
		const [cancelling] = (await list()).runs;
		expect(cancelling).toMatchObject({ status: "running", cancelling: true });
	});

	it("查询参数不符合契约时返回 400", async () => {
		for (const query of ["?status=done", "?orchestration_id=nope", "?limit=0"]) {
			const res = await api.get(`/runs${query}`);
			expect(res.status, query).toBe(400);
			expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
				"invalid_request",
			);
		}
	});
});
