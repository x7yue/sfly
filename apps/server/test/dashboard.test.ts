// 切入点 A：控制台统计接口 GET /dashboard（#34）。HTTP API + 讲真实 gRPC 的假 Agent + 真实 PostgreSQL +
// 手动时钟；响应按契约解析（不符合契约时测试失败）。
import { type DashboardView, dashboardApi, runListApi } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { type AssignedTask, ErrorKind, FakeAgent, type HelloInit } from "./support/fake-agent.js";
import type { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const HOUR = 3_600_000;
const MINUTE = 60_000;

type Node = Record<string, unknown> & { id: string };

const echo = (id: string, extra: Record<string, unknown> = {}): Node => ({
	id,
	kind: "package",
	package: "stub",
	node: "echo",
	inputs: {},
	...extra,
});

/**
 * 由若干条链组成的场景：每条链是按顺序排列的节点（第一个是起点）；
 * dispatch 为 [异步任务节点, 子流程入口节点]。
 */
function scenario(
	chains: Node[][],
	dispatch: Array<[string, string]> = [],
	defaultAgent = "agent-a",
) {
	return {
		default_agent: defaultAgent,
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

/** 入口节点 + 若干 echo 节点的单链场景。 */
const single = (...ids: string[]) =>
	scenario([[{ id: "entry", kind: "entry" }, ...ids.map((id) => echo(id))]]);

/** 主链 entry → spawn → a，子流程 sub → s1 → s2。 */
const withSubflow = () =>
	scenario(
		[
			[{ id: "entry", kind: "entry" }, { id: "spawn", kind: "async", params: {} }, echo("a")],
			[{ id: "sub", kind: "subflow_entry" }, echo("s1"), echo("s2")],
		],
		[["spawn", "sub"]],
	);

describe("控制台统计", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let clock: ManualClock;
	const agents: FakeAgent[] = [];
	const connect = async (hello: HelloInit) => {
		const agent = await FakeAgent.connect(cp.grpcUrl, hello);
		agents.push(agent);
		return agent;
	};

	beforeEach(async () => {
		cp = await startTestControlPlane();
		clock = cp.clock as ManualClock;
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
	});
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
	});

	async function dashboard(): Promise<DashboardView> {
		const res = await cp.fetch("/dashboard");
		expect(res.status).toBe(200);
		return dashboardApi.get.response.parse(await res.json());
	}

	/** 触发一个单节点运行，并让 agent 以给定结果结束它。 */
	async function finishRun(
		agent: FakeAgent,
		orchestrationId: string,
		outcome: "success" | "failed" | "cancelled",
	): Promise<string> {
		const runId = await api.triggerOk(orchestrationId);
		const task: AssignedTask = await agent.nextAssign();
		if (outcome === "success") await agent.succeed(task);
		else if (outcome === "failed") await agent.fail(task);
		else {
			await api.cancelOk(runId);
			await agent.nextCancel();
			await agent.cancelled(task);
		}
		expect((await api.run(runId)).status).toBe(outcome);
		return runId;
	}

	it("最近 24 小时按结束时间统计成功、失败、取消，窗口外的不计入；响应里没有趋势、成功率和最近发布的节点包", async () => {
		const agent = await connect({ name: "agent-a", slots: 4 });
		const id = await api.orchestrationWith(single("a"));

		// 窗口之前：1 成功 1 失败。
		await finishRun(agent, id, "success");
		await finishRun(agent, id, "failed");
		// 最近 24 小时：3 成功、1 失败、1 取消。
		clock.advance(20 * HOUR);
		for (const outcome of ["success", "success", "failed", "cancelled", "success"] as const) {
			await finishRun(agent, id, outcome);
			clock.advance(MINUTE);
		}
		clock.advance(23 * HOUR);

		const { generated_at, runs } = await dashboard();
		expect(generated_at).toBe(clock.now().toISOString());
		expect(runs).toMatchObject({ running: 0, success: 3, failed: 1, cancelled: 1 });

		const raw = (await (await cp.fetch("/dashboard")).json()) as Record<string, unknown>;
		expect(raw).not.toHaveProperty("hourly");
		expect(raw).not.toHaveProperty("recent_packages");
		expect(raw.runs).not.toHaveProperty("success_rate");
		expect(raw.runs).not.toHaveProperty("previous_success_rate");
	});

	it("正在运行：各链（主链与子流程）的节点状态、取消中的运行；运行中的链、执行中与排队的任务数", async () => {
		const a = await connect({ name: "agent-a", slots: 1 });
		const b = await connect({ name: "agent-b", slots: 2 });
		const inspect = await api.orchestrationWith(withSubflow(), "巡检");
		const cleanup = await api.orchestrationWith(
			scenario([[{ id: "entry", kind: "entry" }, echo("b")]], [], "agent-b"),
			"清理",
		);

		const first = await api.triggerOk(inspect);
		// agent-a 只有一个槽位：a 与 s1 一个执行中、一个排队。
		await a.nextAssign();
		clock.advance(1000); // 不超过任务租约（30 秒）
		const second = await api.triggerOk(cleanup);
		await b.nextAssign();
		await api.cancelOk(second);
		await b.nextCancel();

		const view = await dashboard();
		expect(view.runs).toMatchObject({
			running: 2,
			running_chains: 3,
			running_tasks: 2,
			queued_tasks: 1,
		});
		// 按开始时间从新到旧。
		expect(view.running_runs.map((r) => r.id)).toEqual([second, first]);
		const [cancelling, running] = view.running_runs;
		expect(cancelling).toMatchObject({
			orchestration_id: cleanup,
			orchestration_name: "清理",
			cancelling: true,
			chains: [
				{
					chain_id: "entry",
					subflow: false,
					nodes: [
						{ node_id: "entry", status: "success" },
						{ node_id: "b", status: "running" },
					],
				},
			],
		});
		expect(running).toMatchObject({
			orchestration_id: inspect,
			orchestration_name: "巡检",
			orchestration_version: 1,
			triggered_by: "tester",
			started_at: "2026-01-01T00:00:00.000Z",
			cancelling: false,
		});
		const [main, sub] = running?.chains ?? [];
		expect(main).toMatchObject({ chain_id: "entry", subflow: false, status: "running" });
		expect(sub).toMatchObject({ chain_id: "sub", subflow: true, status: "running" });
		const status = (chain: typeof main, node: string) =>
			chain?.nodes.find((n) => n.node_id === node)?.status;
		expect(main?.nodes.map((n) => n.node_id)).toEqual(["entry", "spawn", "a"]);
		expect(sub?.nodes.map((n) => n.node_id)).toEqual(["sub", "s1", "s2"]);
		expect([status(main, "a"), status(sub, "s1")].sort()).toEqual(["queued", "running"]);
		expect(status(sub, "s2")).toBe("pending");
	});

	describe("最近结束", () => {
		const endedIds = async () => (await dashboard()).recent_ended.map((r) => r.id);

		it("窗口按结束时间 [现在 − 24 小时, 现在]：刚好在窗口起点的算在内，早 1 毫秒的在外；还在运行的不列出", async () => {
			const agent = await connect({ name: "agent-a", slots: 4 });
			const id = await api.orchestrationWith(single("a"));

			const before = await finishRun(agent, id, "success");
			clock.advance(1);
			const atStart = await finishRun(agent, id, "failed");
			clock.advance(24 * HOUR);
			const inside = await finishRun(agent, id, "cancelled");
			await api.triggerOk(id);
			await agent.nextAssign();

			const view = await dashboard();
			expect(view.recent_ended.map((r) => r.id)).toEqual([inside, atStart]);
			expect(view.recent_ended).not.toContainEqual(expect.objectContaining({ id: before }));
			expect(view.runs).toMatchObject({ running: 1, success: 0, failed: 1, cancelled: 1 });
		});

		it("按结束时间从新到旧，同一时刻结束的按运行编号倒序，最多 10 个", async () => {
			const agent = await connect({ name: "agent-a", slots: 4 });
			const id = await api.orchestrationWith(single("a"));

			const distinct: string[] = [];
			for (let i = 0; i < 9; i++) {
				distinct.push(await finishRun(agent, id, "success"));
				clock.advance(MINUTE);
			}
			const sameInstant: string[] = [];
			for (let i = 0; i < 3; i++) sameInstant.push(await finishRun(agent, id, "success"));

			const ids = await endedIds();
			expect(ids).toHaveLength(10);
			expect(ids).toEqual([
				...[...sameInstant].sort().reverse(),
				...[...distinct].reverse().slice(0, 7),
			]);
		});

		it("成功、取消、失败的条目带运行的基本信息；只有失败的带 failure", async () => {
			const agent = await connect({ name: "agent-a", slots: 4 });
			const id = await api.orchestrationWith(single("a"), "巡检");
			await api.saveVersion(id, single("a"));

			const started = clock.now().toISOString();
			const success = await finishRun(agent, id, "success");
			clock.advance(MINUTE);
			const cancelled = await finishRun(agent, id, "cancelled");
			clock.advance(MINUTE);
			const failed = await finishRun(agent, id, "failed");
			const ended = clock.now().toISOString();

			const { recent_ended } = await dashboard();
			const common = {
				orchestration_id: id,
				orchestration_name: "巡检",
				orchestration_version: 2,
				triggered_by: "tester",
				ended_at: ended,
			};
			expect(recent_ended.map((r) => [r.id, r.status])).toEqual([
				[failed, "failed"],
				[cancelled, "cancelled"],
				[success, "success"],
			]);
			const [f, c, s] = recent_ended;
			expect(f).toMatchObject({ ...common, started_at: ended, failure: { node_id: "a" } });
			expect(c).toMatchObject({
				...common,
				started_at: new Date(Date.parse(started) + MINUTE).toISOString(),
				ended_at: new Date(Date.parse(started) + MINUTE).toISOString(),
			});
			expect(s).toMatchObject({ ...common, started_at: started, ended_at: started });
			expect(c).not.toHaveProperty("failure");
			expect(s).not.toHaveProperty("failure");
		});

		it("失败的运行给出最先失败的节点、所在的链、最后一次尝试的尝试号与错误；之后失败的 always 节点不算", async () => {
			const agent = await connect({ name: "agent-a", slots: 4 });
			const id = await api.orchestrationWith(
				scenario([
					[{ id: "entry", kind: "entry" }, echo("a", { retries: 1 }), echo("c", { always: true })],
				]),
				"清理",
			);

			const runId = await api.triggerOk(id);
			await agent.fail(await agent.nextAssign(), "第一次失败");
			const retry = await agent.nextAssign();
			expect(retry.attempt).toBe(2);
			clock.advance(MINUTE);
			await agent.fail(retry, "等待响应超时", ErrorKind.TIMEOUT);
			clock.advance(MINUTE);
			await agent.fail(await agent.nextAssign(), "清理失败");

			const { recent_ended } = await dashboard();
			expect(recent_ended).toHaveLength(1);
			const [ended] = recent_ended;
			expect(ended).toMatchObject({ id: runId, status: "failed" });
			const mainChain = (await api.run(runId)).chains[0];
			expect(ended?.status === "failed" && ended.failure).toEqual({
				chain_instance_id: mainChain?.id,
				chain_id: "entry",
				subflow: false,
				node_id: "a",
				attempt: 2,
				error: { kind: "timeout", message: "等待响应超时" },
			});
		});

		it("主链成功、子流程节点失败导致运行失败时，failure 是子流程的链与节点", async () => {
			const agent = await connect({ name: "agent-a", slots: 4 });
			const id = await api.orchestrationWith(withSubflow(), "巡检");

			const runId = await api.triggerOk(id);
			const first = await agent.nextAssign();
			const second = await agent.nextAssign();
			const [a, s1] = first.nodeId === "a" ? [first, second] : [second, first];
			await agent.succeed(a);
			await agent.fail(s1, "校验失败");
			expect((await api.run(runId)).status).toBe("failed");

			const subChain = (await api.run(runId)).chains.find((c) => c.chain_id === "sub");
			const [ended] = (await dashboard()).recent_ended;
			expect(ended?.status === "failed" && ended.failure).toEqual({
				chain_instance_id: subChain?.id,
				chain_id: "sub",
				subflow: true,
				subflow_name: "sub",
				node_id: "s1",
				attempt: 1,
				error: { kind: "node_error", message: "校验失败" },
			});
		});

		it("多条链上的节点失败时，取最先结束的；同一时刻结束的取靠前的链", async () => {
			const agent = await connect({ name: "agent-a", slots: 4 });
			const id = await api.orchestrationWith(withSubflow(), "巡检");
			const failBoth = async (order: "sub-first" | "same-instant") => {
				const runId = await api.triggerOk(id);
				const first = await agent.nextAssign();
				const second = await agent.nextAssign();
				const [a, s1] = first.nodeId === "a" ? [first, second] : [second, first];
				await agent.fail(s1, "子流程失败");
				if (order === "sub-first") clock.advance(MINUTE);
				await agent.fail(a, "主链失败");
				return runId;
			};
			const subFirst = await failBoth("sub-first");
			clock.advance(MINUTE);
			const sameInstant = await failBoth("same-instant");

			const { recent_ended } = await dashboard();
			const failureOf = (runId: string) => {
				const ended = recent_ended.find((r) => r.id === runId);
				return ended?.status === "failed" ? ended.failure : undefined;
			};
			expect(failureOf(subFirst)).toMatchObject({ chain_id: "sub", node_id: "s1" });
			expect(failureOf(sameInstant)).toMatchObject({ chain_id: "entry", node_id: "a" });
		});

		it("子流程失败时主链还在运行：运行不列入最近结束，失败的子流程仍计入 failed_subflows", async () => {
			const agent = await connect({ name: "agent-a", slots: 4 });
			const id = await api.orchestrationWith(withSubflow(), "巡检");

			// 24 小时之前失败的子流程不计入。
			await api.triggerOk(id);
			const [x, y] = [await agent.nextAssign(), await agent.nextAssign()];
			await agent.fail(x.nodeId === "s1" ? x : y);
			await agent.fail(x.nodeId === "s1" ? y : x);
			clock.advance(25 * HOUR);

			await api.triggerOk(id);
			const [p, q] = [await agent.nextAssign(), await agent.nextAssign()];
			await agent.fail(p.nodeId === "s1" ? p : q);

			const view = await dashboard();
			expect(view.runs).toMatchObject({ running: 1, failed: 0, failed_subflows: 1 });
			expect(view.recent_ended).toEqual([]);
		});

		it("失败的错误信息里的 secret 参数值已打码", async () => {
			const agent = await connect({ name: "agent-a", slots: 4 });
			const id = await api.orchestrationWith(
				scenario([
					[
						{
							id: "entry",
							kind: "entry",
							params: [{ name: "token", type: "string", secret: true, required: true }],
						},
						echo("a"),
					],
				]),
			);
			await api.triggerOk(id, { token: "s3cr3t" });
			await agent.fail(await agent.nextAssign(), "登录失败：token=s3cr3t");

			const [ended] = (await dashboard()).recent_ended;
			expect(ended?.status === "failed" && ended.failure?.error).toEqual({
				kind: "node_error",
				message: "登录失败：token=******",
			});
		});
	});

	it("进行中的节点与运行列表一致；子流程实例指向派发它的链实例与异步任务节点，主链为 null", async () => {
		const a = await connect({ name: "agent-a", slots: 1 });
		const id = await api.orchestrationWith(withSubflow(), "巡检");
		const runId = await api.triggerOk(id);
		// 只有一个槽位：main 链的 a 与子流程的 s1 一个执行中、一个排队。
		await a.nextAssign();

		const { running_runs } = await dashboard();
		const [run] = running_runs;
		const listed = runListApi.list.response.parse(await (await cp.fetch("/runs")).json()).runs;
		expect(run?.id).toBe(runId);
		expect(run?.active_nodes).toEqual(listed.find((r) => r.id === runId)?.active_nodes);
		expect(run?.active_nodes.map((n) => [n.status, n.agent, n.attempt])).toEqual(
			expect.arrayContaining([
				["running", "agent-a", 1],
				["queued", "agent-a", 1],
			]),
		);
		expect(run?.active_nodes).toHaveLength(2);

		const [main, sub] = run?.chains ?? [];
		expect(main).toMatchObject({ parent_chain_instance_id: null, async_node_id: null });
		expect(sub).toMatchObject({
			chain_id: "sub",
			parent_chain_instance_id: main?.id,
			async_node_id: "spawn",
		});
	});

	it("Agent：在线与离线数量、在线 Agent 的槽位合计与占用；响应里没有 Agent 清单", async () => {
		const a = await connect({ name: "agent-a", slots: 2 });
		await connect({ name: "agent-b", slots: 3 });
		await (await connect({ name: "agent-c", slots: 4 })).disconnect();
		const id = await api.orchestrationWith(single("a"));
		await api.triggerOk(id);
		await a.nextAssign();

		await eventually(async () =>
			expect((await dashboard()).agents).toEqual({
				online: 2,
				offline: 1,
				slots: 5,
				used_slots: 1,
			}),
		);
		const raw = (await (await cp.fetch("/dashboard")).json()) as { agents: object };
		expect(raw.agents).not.toHaveProperty("list");
	});
});

describe("控制台的开始使用", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	const agents: FakeAgent[] = [];
	const connect = async (hello: HelloInit) => {
		const agent = await FakeAgent.connect(cp.grpcUrl, hello);
		agents.push(agent);
		return agent;
	};
	const clock = () => cp.clock as ManualClock;
	const setup = async () => {
		const res = await cp.fetch("/dashboard");
		expect(res.status).toBe(200);
		return dashboardApi.get.response.parse(await res.json()).setup;
	};

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
	});
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
	});

	it("全新环境：四步都没完成", async () => {
		expect(await setup()).toEqual({
			agent: { done: false, online: 0, name: null },
			package: { done: false, count: 0, latest: null },
			scenario: { done: false, count: 0, name: null },
			run: { done: false },
		});
	});

	it("接入 Agent：有在线的 Agent 才算完成；写出名称排在最前的在线 Agent，离线的不计", async () => {
		await (await connect({ name: "agent-a", slots: 1 })).disconnect();
		await eventually(async () =>
			expect((await setup()).agent).toEqual({ done: false, online: 0, name: null }),
		);

		await connect({ name: "agent-c", slots: 1 });
		expect((await setup()).agent).toEqual({ done: true, online: 1, name: "agent-c" });

		await connect({ name: "agent-b", slots: 1 });
		expect((await setup()).agent).toEqual({ done: true, online: 2, name: "agent-b" });
	});

	it("发布节点包：有任何一个版本就算完成；个数按包名数，最新是最近发布的版本", async () => {
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
		expect((await setup()).package).toEqual({
			done: true,
			count: 1,
			latest: { name: "stub", version: "1.0.0" },
		});

		for (const [name, version] of [
			["stub", "1.1.0"],
			["other", "0.2.0"],
			["stub", "1.2.0"],
		] as const) {
			clock().advance(1000);
			await publishPackage(cp, name, version, { echo: ["v"] });
		}
		expect((await setup()).package).toEqual({
			done: true,
			count: 2,
			latest: { name: "stub", version: "1.2.0" },
		});
	});

	it("新建场景：有没有归档的场景就算完成，已归档的不计；写出最近新建的场景", async () => {
		const first = await api.createOrchestration("巡检");
		expect((await setup()).scenario).toEqual({ done: true, count: 1, name: "巡检" });

		clock().advance(1000);
		const second = await api.createOrchestration("压测");
		expect((await setup()).scenario).toEqual({ done: true, count: 2, name: "压测" });

		await api.postEmpty(`/orchestrations/${first}/archive`);
		expect((await setup()).scenario).toEqual({ done: true, count: 1, name: "压测" });
		await api.postEmpty(`/orchestrations/${second}/archive`);
		expect((await setup()).scenario).toEqual({ done: false, count: 0, name: null });
	});

	it("触发第一次运行：有任何一个运行就算完成，运行结束了也一样", async () => {
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
		const agent = await connect({ name: "agent-a", slots: 1 });
		const id = await api.orchestrationWith(single("a"));
		expect((await setup()).run).toEqual({ done: false });

		await api.triggerOk(id);
		expect((await setup()).run).toEqual({ done: true });
		await agent.succeed(await agent.nextAssign());
		expect((await setup()).run).toEqual({ done: true });
	});
});
