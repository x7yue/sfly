// 切入点 A：控制台统计接口 GET /dashboard（#34）。HTTP API + 讲真实 gRPC 的假 Agent + 真实 PostgreSQL +
// 手动时钟；响应按契约解析（不符合契约时测试失败）。
import { type DashboardView, dashboardApi } from "@sfly/schema";
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

	it("最近 24 小时按结束时间统计成功、失败、取消与成功率，窗口外的不计入，并与前 24 小时对比", async () => {
		const agent = await connect({ name: "agent-a", slots: 4 });
		const id = await api.orchestrationWith(single("a"));

		// 前一个 24 小时：1 成功 1 失败（成功率 0.5）。
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
		expect(runs).toMatchObject({
			running: 0,
			success: 3,
			failed: 1,
			cancelled: 1,
			success_rate: 0.6,
			previous_success_rate: 0.5,
		});
	});

	it("按小时的趋势：24 个桶以现在为终点，运行按结束时间归桶", async () => {
		const agent = await connect({ name: "agent-a", slots: 4 });
		const id = await api.orchestrationWith(single("a"));
		clock.set("2026-01-01T06:00:00.000Z");
		await finishRun(agent, id, "cancelled");
		clock.set("2026-01-01T07:30:00.000Z");
		await finishRun(agent, id, "success");
		await finishRun(agent, id, "failed");
		clock.set("2026-01-02T05:59:00.000Z");
		await finishRun(agent, id, "success");
		clock.set("2026-01-02T06:00:00.000Z");

		const { hourly } = await dashboard();
		expect(hourly).toHaveLength(24);
		expect(hourly[0]).toEqual({
			start: "2026-01-01T06:00:00.000Z",
			success: 0,
			failed: 0,
			cancelled: 1,
		});
		expect(hourly[1]).toEqual({
			start: "2026-01-01T07:00:00.000Z",
			success: 1,
			failed: 1,
			cancelled: 0,
		});
		expect(hourly[2]).toEqual({
			start: "2026-01-01T08:00:00.000Z",
			success: 0,
			failed: 0,
			cancelled: 0,
		});
		expect(hourly.slice(2, 23).every((h) => h.success + h.failed + h.cancelled === 0)).toBe(true);
		expect(hourly[23]).toEqual({
			start: "2026-01-02T05:00:00.000Z",
			success: 1,
			failed: 0,
			cancelled: 0,
		});
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

	it("最近失败：每个失败的链一条，给出最先失败的节点与错误类型；子流程失败单独列出（主链可能仍在运行）", async () => {
		const agent = await connect({ name: "agent-a", slots: 4 });
		const cleanup = await api.orchestrationWith(
			scenario([[{ id: "entry", kind: "entry" }, echo("a"), echo("c", { always: true })]]),
			"清理",
		);
		const inspect = await api.orchestrationWith(withSubflow(), "巡检");

		// 24 小时之前的失败不列出。
		await api.triggerOk(cleanup);
		await agent.fail(await agent.nextAssign());
		await agent.fail(await agent.nextAssign());
		clock.advance(25 * HOUR);

		// a 超时失败后 always 节点 c 照常执行并也失败：失败节点仍是最先失败的 a。
		const failedRun = await api.triggerOk(cleanup);
		await agent.fail(await agent.nextAssign(), "等待响应超时", ErrorKind.TIMEOUT);
		clock.advance(MINUTE);
		await agent.fail(await agent.nextAssign(), "清理失败");
		expect((await api.run(failedRun)).status).toBe("failed");

		// 子流程的 s1 失败，主链的 a 仍在执行。
		clock.advance(MINUTE);
		const running = await api.triggerOk(inspect);
		const first = await agent.nextAssign();
		const second = await agent.nextAssign();
		const s1 = first.nodeId === "s1" ? first : second;
		clock.advance(1000);
		await agent.fail(s1, "校验失败");

		const view = await dashboard();
		expect(view.runs).toMatchObject({ failed: 1, failed_subflows: 1 });
		expect(view.recent_failures).toMatchObject([
			{
				run_id: running,
				orchestration_id: inspect,
				orchestration_name: "巡检",
				run_status: "running",
				chain_id: "sub",
				subflow: true,
				node_id: "s1",
				error: { kind: "node_error", message: "校验失败" },
				failed_at: "2026-01-02T01:02:01.000Z",
			},
			{
				run_id: failedRun,
				orchestration_id: cleanup,
				orchestration_name: "清理",
				run_status: "failed",
				chain_id: "entry",
				subflow: false,
				node_id: "a",
				error: { kind: "timeout", message: "等待响应超时" },
				failed_at: "2026-01-02T01:01:00.000Z",
			},
		]);
	});

	it("最近失败的错误信息里的 secret 参数值已打码", async () => {
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

		const [failure] = (await dashboard()).recent_failures;
		expect(failure?.error).toEqual({ kind: "node_error", message: "登录失败：token=******" });
	});

	it("Agent：在线与离线数量、在线 Agent 的槽位合计与占用、正在安装节点包的 Agent", async () => {
		const a = await connect({ name: "agent-a", slots: 2 });
		const b = await connect({ name: "agent-b", slots: 3 });
		await (await connect({ name: "agent-c", slots: 4 })).disconnect();
		const id = await api.orchestrationWith(single("a"));
		await api.triggerOk(id);
		await a.nextAssign();
		b.send({
			case: "install",
			value: { package: "stub", version: "1.0.0", state: 1, taskId: "t-1", installedPackages: [] },
		});

		await eventually(async () =>
			expect((await dashboard()).agents.list.find((x) => x.name === "agent-b")?.installing).toEqual(
				{ package: "stub", version: "1.0.0" },
			),
		);
		expect((await dashboard()).agents).toEqual({
			online: 2,
			offline: 1,
			slots: 5,
			used_slots: 1,
			list: [
				{
					name: "agent-a",
					status: "online",
					slots: 2,
					used_slots: 1,
					installing: null,
					last_seen_at: "2026-01-01T00:00:00.000Z",
				},
				{
					name: "agent-b",
					status: "online",
					slots: 3,
					used_slots: 0,
					installing: { package: "stub", version: "1.0.0" },
					last_seen_at: "2026-01-01T00:00:00.000Z",
				},
				{
					name: "agent-c",
					status: "offline",
					slots: 4,
					used_slots: 0,
					installing: null,
					last_seen_at: "2026-01-01T00:00:00.000Z",
				},
			],
		});
	});

	it("最近发布的节点包：最新的 5 个版本，从新到旧，带被场景锁定的数量", async () => {
		for (const version of ["0.1.0", "0.2.0", "0.3.0", "0.4.0", "0.5.0"]) {
			clock.advance(HOUR);
			await publishPackage(cp, "demo", version, { echo: ["v"] });
		}
		await api.orchestrationWith({
			...single("a"),
			nodes: [
				{ id: "entry", kind: "entry" },
				{ id: "a", kind: "package", package: "demo", node: "echo", inputs: {} },
			],
			packages: { demo: "0.4.0" },
		});

		expect((await dashboard()).recent_packages).toEqual([
			{
				name: "demo",
				version: "0.5.0",
				published_at: "2026-01-01T05:00:00.000Z",
				locked_orchestrations: 0,
			},
			{
				name: "demo",
				version: "0.4.0",
				published_at: "2026-01-01T04:00:00.000Z",
				locked_orchestrations: 1,
			},
			{
				name: "demo",
				version: "0.3.0",
				published_at: "2026-01-01T03:00:00.000Z",
				locked_orchestrations: 0,
			},
			{
				name: "demo",
				version: "0.2.0",
				published_at: "2026-01-01T02:00:00.000Z",
				locked_orchestrations: 0,
			},
			{
				name: "demo",
				version: "0.1.0",
				published_at: "2026-01-01T01:00:00.000Z",
				locked_orchestrations: 0,
			},
		]);
	});
});
