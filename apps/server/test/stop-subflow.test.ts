// 切入点 A：停止子流程节点（docs/SEMANTICS.md §4.1、ADR 0016）。
// HTTP API + 讲真实 gRPC 的假 Agent + 真实 PostgreSQL + 手动时钟。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { chainOf, echo, type Node, orchestration, spawn, statuses } from "./support/chains.js";
import { type AssignedTask, FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const stop = (id: string, subflow: string, extra: Record<string, unknown> = {}): Node => ({
	id,
	kind: "stop_subflow",
	subflow,
	...extra,
});
const entry = (id = "entry"): Node => ({ id, kind: "entry", params: [] });
const subflowEntry = (id: string, name = id): Node => ({
	id,
	kind: "subflow_entry",
	name,
	params: [],
});

describe("停止子流程节点", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let agent: FakeAgent;

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 8 });
	});
	afterEach(async () => {
		await agent.disconnect();
		await cp.close();
	});

	/** 依次收下 n 个派发，按节点 ID 返回。 */
	async function assigns(n: number): Promise<Record<string, AssignedTask>> {
		const out: Record<string, AssignedTask> = {};
		for (let i = 0; i < n; i++) {
			const task = await agent.nextAssign();
			out[task.nodeId] = task;
		}
		return out;
	}

	it("停止运行中的任务：任务按取消的方式终止并记为已停止，always 节点照常执行，停止子流程节点等子流程结束后才成功，主链继续", async () => {
		const id = await api.orchestrationWith(
			orchestration(
				[
					[entry(), spawn("spawn"), echo("load"), stop("stop", "mon"), echo("cleanup")],
					[
						subflowEntry("mon", "监控"),
						echo("watch"),
						echo("after"),
						{ ...echo("flush"), always: true },
					],
				],
				[["spawn", "mon"]],
			),
		);
		const runId = await api.triggerOk(id);
		const first = await assigns(2);
		await agent.succeed(first.load as AssignedTask);

		// 停止子流程节点通过已有的取消路径通知 Agent，自己进入等待。
		const cancel = await agent.nextCancel();
		expect(cancel).toMatchObject({ taskId: first.watch?.taskId, force: false });
		let run = await api.run(runId);
		expect(statuses(chainOf(run, "entry"))).toMatchObject({ stop: "waiting", cleanup: "pending" });
		expect(chainOf(run, "entry").nodes.find((n) => n.node_id === "stop")).toMatchObject({
			kind: "stop_subflow",
			agent: null,
			attempts: [expect.objectContaining({ inputs: { subflow: "mon" } })],
		});
		expect(chainOf(run, "mon")).toMatchObject({ status: "running", name: "监控" });
		expect(chainOf(run, "entry").name).toBeNull();

		// Agent 终止任务后上报取消：记为已停止，后面的普通节点已停止，always 节点照常执行。
		await agent.cancelled(first.watch as AssignedTask);
		const flush = await agent.nextAssign();
		expect(flush.nodeId).toBe("flush");
		run = await api.run(runId);
		expect(statuses(chainOf(run, "mon"))).toEqual({
			mon: "success",
			watch: "stopped",
			after: "stopped",
			flush: "running",
		});
		expect(statuses(chainOf(run, "entry"))).toMatchObject({ stop: "waiting" });
		await agent.expectNoAssign();

		// 子流程完全结束后，停止子流程节点成功、输出子流程的结果，主链继续。
		await agent.succeed(flush);
		const cleanup = await agent.nextAssign();
		expect(cleanup.nodeId).toBe("cleanup");
		run = await api.run(runId);
		expect(chainOf(run, "mon").status).toBe("success");
		expect(chainOf(run, "entry").nodes.find((n) => n.node_id === "stop")).toMatchObject({
			status: "success",
			outputs: { status: "success" },
		});
		await agent.succeed(cleanup);
		run = await api.run(runId);
		expect(run.chains.map((c) => [c.chain_id, c.status])).toEqual([
			["entry", "success"],
			["mon", "success"],
		]);
		expect(run.status).toBe("success");
	});

	it("停止等待中的 Sleep 节点、排队中的任务和未开始的节点：立即记为已停止，没有 always 节点时停止子流程节点立即成功", async () => {
		// agent-b 已注册但不在线：派发给它的任务一直排队。
		await (await FakeAgent.connect(cp.grpcUrl, { name: "agent-b" })).disconnect();
		const id = await api.orchestrationWith(
			orchestration(
				[
					[
						entry(),
						spawn("spawn1"),
						spawn("spawn2"),
						echo("load"),
						stop("stop1", "waiting"),
						stop("stop2", "queued"),
						echo("cleanup"),
					],
					[subflowEntry("waiting"), { id: "nap", kind: "sleep", duration: "1h" }, echo("after1")],
					[subflowEntry("queued"), { ...echo("remote"), agent: "agent-b" }, echo("after2")],
				],
				[
					["spawn1", "waiting"],
					["spawn2", "queued"],
				],
			),
		);
		const runId = await api.triggerOk(id);
		let run = await api.run(runId);
		expect(statuses(chainOf(run, "waiting"))).toMatchObject({ nap: "waiting" });
		expect(statuses(chainOf(run, "queued"))).toMatchObject({ remote: "queued" });

		await agent.succeed(await agent.nextAssign());
		const cleanup = await agent.nextAssign();
		expect(cleanup.nodeId).toBe("cleanup");
		await agent.expectNoCancel();
		run = await api.run(runId);
		expect(statuses(chainOf(run, "waiting"))).toEqual({
			waiting: "success",
			nap: "stopped",
			after1: "stopped",
		});
		expect(statuses(chainOf(run, "queued"))).toEqual({
			queued: "success",
			remote: "stopped",
			after2: "stopped",
		});
		expect(chainOf(run, "waiting").status).toBe("success");
		expect(chainOf(run, "queued").status).toBe("success");
		for (const nodeId of ["stop1", "stop2"]) {
			expect(chainOf(run, "entry").nodes.find((n) => n.node_id === nodeId)).toMatchObject({
				status: "success",
				outputs: { status: "success" },
			});
		}

		await agent.succeed(cleanup);
		run = await api.run(runId);
		expect(run.status).toBe("success");
	});

	it("子流程在停止前已经失败：子流程记为失败，停止子流程节点仍然成功并输出 failed，主链继续，运行最终失败", async () => {
		const id = await api.orchestrationWith(
			orchestration(
				[
					[entry(), spawn("spawn"), echo("load"), stop("stop", "mon"), echo("cleanup")],
					[subflowEntry("mon"), echo("probe"), { ...echo("flush"), always: true }, echo("watch")],
				],
				[["spawn", "mon"]],
			),
		);
		const runId = await api.triggerOk(id);
		const first = await assigns(2);
		await agent.fail(first.probe as AssignedTask, "probe boom");
		const flush = await agent.nextAssign();
		expect(flush.nodeId).toBe("flush");

		// 子流程正在执行 always 节点时被停止：always 节点照常执行完，后面的普通节点不再执行。
		await agent.succeed(first.load as AssignedTask);
		await agent.expectNoCancel();
		let run = await api.run(runId);
		expect(statuses(chainOf(run, "entry"))).toMatchObject({ stop: "waiting" });

		await agent.succeed(flush);
		const cleanup = await agent.nextAssign();
		expect(cleanup.nodeId).toBe("cleanup");
		run = await api.run(runId);
		expect(chainOf(run, "mon").status).toBe("failed");
		expect(statuses(chainOf(run, "mon"))).toMatchObject({ probe: "failed", flush: "success" });
		expect(chainOf(run, "entry").nodes.find((n) => n.node_id === "stop")).toMatchObject({
			status: "success",
			outputs: { status: "failed" },
		});

		await agent.succeed(cleanup);
		run = await api.run(runId);
		expect(chainOf(run, "entry").status).toBe("success");
		expect(run.status).toBe("failed");
	});
});

describe("停止子流程节点的引用检查（保存时警告，触发时阻断）", () => {
	let cp: TestControlPlane;
	let api: ApiClient;

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
		await (await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" })).disconnect();
	});
	afterEach(async () => {
		await cp.close();
	});

	/** 主链 entry → spawn → stop（停止 target）；stopAt="before" 时 stop 在 spawn 之前。 */
	const scene = (target: string | undefined, stopAt: "after" | "before" = "after") => {
		const stopper =
			target === undefined ? { id: "stop", kind: "stop_subflow" } : stop("stop", target);
		return orchestration(
			[
				stopAt === "after"
					? [entry(), spawn("spawn"), stopper]
					: [entry(), stopper, spawn("spawn")],
				[subflowEntry("mon", "监控"), echo("watch")],
			],
			[["spawn", "mon"]],
		);
	};

	it("没有选择、目标不存在或顺序不对时保存成功但返回警告，触发被拒绝；改正后可以触发", async () => {
		const id = await api.createOrchestration("停止子流程");
		const check = async (doc: unknown) => {
			const saved = await api.post(`/orchestrations/${id}/versions`, {
				base_version: await api.headVersion(id),
				document: doc,
			});
			expect(saved.status).toBe(201);
			const { warnings } = (await saved.json()) as {
				warnings: { code: string; node_id?: string }[];
			};
			const res = await api.trigger(id);
			const problems =
				res.status === 201
					? []
					: ((await res.json()) as { error: { details: { code: string; node_id?: string }[] } })
							.error.details;
			return {
				warnings: warnings.map((w) => [w.code, w.node_id]),
				problems: problems.map((p) => [p.code, p.node_id]),
			};
		};

		expect(await check(scene(undefined))).toEqual({
			warnings: [["stop_subflow_unset", "stop"]],
			problems: [["stop_subflow_unset", "stop"]],
		});
		expect(await check(scene("gone"))).toEqual({
			warnings: [["stop_subflow_unknown", "stop"]],
			problems: [["stop_subflow_unknown", "stop"]],
		});
		expect(await check(scene("mon", "before"))).toEqual({
			warnings: [["stop_subflow_before_trigger", "stop"]],
			problems: [["stop_subflow_before_trigger", "stop"]],
		});
		expect(await check(scene("mon"))).toEqual({ warnings: [], problems: [] });
	});
});
