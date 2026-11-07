// 切入点 A：停止子流程节点（docs/SEMANTICS.md §4.1、ADR 0016）。
// HTTP API + 讲真实 gRPC 的假 Agent + 真实 PostgreSQL + 手动时钟。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { chainOf, echo, type Node, orchestration, spawn, statuses } from "./support/chains.js";
import { type AssignedTask, ErrorKind, FakeAgent } from "./support/fake-agent.js";
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

describe("停止子流程节点的边界情况", () => {
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
	async function assigns(n: number, from = agent): Promise<Record<string, AssignedTask>> {
		const out: Record<string, AssignedTask> = {};
		for (let i = 0; i < n; i++) {
			const task = await from.nextAssign();
			out[task.nodeId] = task;
		}
		return out;
	}
	/** 依次收下 n 个取消指令，返回被取消的任务 ID。 */
	async function cancels(n: number, from = agent): Promise<string[]> {
		const out: string[] = [];
		for (let i = 0; i < n; i++) out.push((await from.nextCancel()).taskId);
		return out.sort();
	}
	const stopNode = (run: Awaited<ReturnType<ApiClient["run"]>>, nodeId = "stop") =>
		chainOf(run, "entry").nodes.find((n) => n.node_id === nodeId);

	it("嵌套两层的子流程一起停止：各层任务按取消的方式终止，各层 always 节点照常执行，停止子流程节点等两层都结束后才成功", async () => {
		const id = await api.orchestrationWith(
			orchestration(
				[
					[entry(), spawn("spawn"), echo("load"), stop("stop", "mon"), echo("cleanup")],
					[
						subflowEntry("mon"),
						spawn("spawn_deep"),
						echo("watch"),
						{ ...echo("flush"), always: true },
					],
					[
						subflowEntry("deep"),
						echo("tail"),
						echo("after"),
						{ ...echo("flush_deep"), always: true },
					],
				],
				[
					["spawn", "mon"],
					["spawn_deep", "deep"],
				],
			),
		);
		const runId = await api.triggerOk(id);
		const first = await assigns(3);
		await agent.succeed(first.load as AssignedTask);

		expect(await cancels(2)).toEqual([first.watch?.taskId, first.tail?.taskId].sort());
		await agent.cancelled(first.tail as AssignedTask);
		const flushDeep = await agent.nextAssign();
		expect(flushDeep.nodeId).toBe("flush_deep");
		await agent.cancelled(first.watch as AssignedTask);
		const flush = await agent.nextAssign();
		expect(flush.nodeId).toBe("flush");

		// 上层先结束：下层的 always 节点还在执行，停止子流程节点继续等待。
		await agent.succeed(flush);
		let run = await api.run(runId);
		expect(chainOf(run, "mon").status).toBe("success");
		expect(stopNode(run)?.status).toBe("waiting");
		await agent.expectNoAssign();

		await agent.succeed(flushDeep);
		const cleanup = await agent.nextAssign();
		expect(cleanup.nodeId).toBe("cleanup");
		run = await api.run(runId);
		expect(statuses(chainOf(run, "mon"))).toEqual({
			mon: "success",
			spawn_deep: "success",
			watch: "stopped",
			flush: "success",
		});
		expect(statuses(chainOf(run, "deep"))).toEqual({
			deep: "success",
			tail: "stopped",
			after: "stopped",
			flush_deep: "success",
		});
		expect(stopNode(run)).toMatchObject({ status: "success", outputs: { status: "success" } });
		await agent.succeed(cleanup);
		run = await api.run(runId);
		expect(run.status).toBe("success");
	});

	it("目标子流程还没被触发（触发它的异步任务节点被跳过）时立即成功，status 为 null", async () => {
		const id = await api.orchestrationWith(
			orchestration(
				[
					[entry(), spawn("spawn"), echo("load"), stop("stop", "deep"), echo("cleanup")],
					[subflowEntry("mon"), echo("fragile"), spawn("spawn_deep")],
					[subflowEntry("deep"), echo("tail")],
				],
				[
					["spawn", "mon"],
					["spawn_deep", "deep"],
				],
			),
		);
		const runId = await api.triggerOk(id);
		const first = await assigns(2);
		await agent.fail(first.fragile as AssignedTask);
		await agent.succeed(first.load as AssignedTask);
		const cleanup = await agent.nextAssign();
		expect(cleanup.nodeId).toBe("cleanup");
		await agent.expectNoCancel();
		const run = await api.run(runId);
		expect(statuses(chainOf(run, "mon"))).toMatchObject({ spawn_deep: "skipped" });
		expect(run.chains.map((c) => c.chain_id)).toEqual(["entry", "mon"]);
		expect(stopNode(run)).toMatchObject({ status: "success", outputs: { status: null } });
	});

	it("目标子流程已经结束时立即成功，status 为它的结果", async () => {
		const id = await api.orchestrationWith(
			orchestration(
				[
					[
						entry(),
						spawn("spawn_ok"),
						spawn("spawn_bad"),
						echo("load"),
						stop("stop_ok", "ok"),
						stop("stop_bad", "bad"),
						echo("cleanup"),
					],
					[subflowEntry("ok"), echo("quick")],
					[subflowEntry("bad"), echo("broken")],
				],
				[
					["spawn_ok", "ok"],
					["spawn_bad", "bad"],
				],
			),
		);
		const runId = await api.triggerOk(id);
		const first = await assigns(3);
		await agent.succeed(first.quick as AssignedTask);
		await agent.fail(first.broken as AssignedTask);
		await agent.succeed(first.load as AssignedTask);
		const cleanup = await agent.nextAssign();
		expect(cleanup.nodeId).toBe("cleanup");
		await agent.expectNoCancel();
		const run = await api.run(runId);
		expect(stopNode(run, "stop_ok")).toMatchObject({
			status: "success",
			outputs: { status: "success" },
		});
		expect(stopNode(run, "stop_bad")).toMatchObject({
			status: "success",
			outputs: { status: "failed" },
		});
	});

	it("被停止的任务没有按取消结束、而是上报失败：记为失败且不重试，子流程记为失败，停止子流程节点输出 failed", async () => {
		const id = await api.orchestrationWith(
			orchestration(
				[
					[entry(), spawn("spawn"), echo("load"), stop("stop", "mon"), echo("cleanup")],
					[
						subflowEntry("mon"),
						{ ...echo("watch"), retries: 2 },
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
		expect(await cancels(1)).toEqual([first.watch?.taskId]);

		// 停止前后节点自己出错（例如收尾时超时）：这是失败，不是停止。
		await agent.fail(first.watch as AssignedTask, "watch timed out", ErrorKind.TIMEOUT);
		const flush = await agent.nextAssign();
		expect(flush.nodeId).toBe("flush");
		await agent.succeed(flush);
		const cleanup = await agent.nextAssign();
		expect(cleanup.nodeId).toBe("cleanup");
		let run = await api.run(runId);
		const watch = chainOf(run, "mon").nodes.find((n) => n.node_id === "watch");
		expect(watch).toMatchObject({ status: "failed" });
		expect(watch?.attempts).toHaveLength(1);
		expect(statuses(chainOf(run, "mon"))).toMatchObject({ after: "stopped", flush: "success" });
		expect(chainOf(run, "mon").status).toBe("failed");
		expect(stopNode(run)).toMatchObject({ status: "success", outputs: { status: "failed" } });

		await agent.succeed(cleanup);
		run = await api.run(runId);
		expect(run.status).toBe("failed");
	});

	it("停止子流程节点设为 always：主链前面失败后它照样停止子流程，后面的普通节点跳过，运行失败", async () => {
		const id = await api.orchestrationWith(
			orchestration(
				[
					[
						entry(),
						spawn("spawn"),
						echo("load"),
						stop("stop", "mon", { always: true }),
						echo("report"),
						{ ...echo("cleanup"), always: true },
					],
					[subflowEntry("mon"), echo("watch")],
				],
				[["spawn", "mon"]],
			),
		);
		const runId = await api.triggerOk(id);
		const first = await assigns(2);
		await agent.fail(first.load as AssignedTask);
		expect((await agent.nextCancel()).taskId).toBe(first.watch?.taskId);
		await agent.cancelled(first.watch as AssignedTask);
		const cleanup = await agent.nextAssign();
		expect(cleanup.nodeId).toBe("cleanup");
		let run = await api.run(runId);
		expect(statuses(chainOf(run, "mon"))).toEqual({ mon: "success", watch: "stopped" });
		expect(chainOf(run, "mon").status).toBe("success");
		expect(stopNode(run)).toMatchObject({ status: "success", outputs: { status: "success" } });
		expect(statuses(chainOf(run, "entry"))).toMatchObject({ load: "failed", report: "skipped" });
		await agent.succeed(cleanup);
		run = await api.run(runId);
		expect(run.status).toBe("failed");
	});

	it("目标已被另一个停止子流程节点停止：等那次停止完成，输出该子流程的结果", async () => {
		const id = await api.orchestrationWith(
			orchestration(
				[
					[entry(), spawn("spawn"), echo("load"), stop("stop", "deep"), echo("cleanup")],
					[subflowEntry("mid"), spawn("spawn_deep"), echo("work"), stop("stop_mid", "deep")],
					[subflowEntry("deep"), echo("tail"), { ...echo("flush"), always: true }],
				],
				[
					["spawn", "mid"],
					["spawn_deep", "deep"],
				],
			),
		);
		const runId = await api.triggerOk(id);
		const first = await assigns(3);
		await agent.succeed(first.work as AssignedTask);
		expect((await agent.nextCancel()).taskId).toBe(first.tail?.taskId);

		// 主链上的停止子流程节点到达时子流程正在被停止：不再重复通知 Agent，等它结束。
		await agent.succeed(first.load as AssignedTask);
		await agent.expectNoCancel();
		let run = await api.run(runId);
		expect(stopNode(run)?.status).toBe("waiting");

		await agent.cancelled(first.tail as AssignedTask);
		const flush = await agent.nextAssign();
		expect(flush.nodeId).toBe("flush");
		await agent.expectNoAssign();
		await agent.fail(flush);
		const cleanup = await agent.nextAssign();
		expect(cleanup.nodeId).toBe("cleanup");
		run = await api.run(runId);
		expect(chainOf(run, "deep").status).toBe("failed");
		expect(stopNode(run)).toMatchObject({ status: "success", outputs: { status: "failed" } });
		expect(chainOf(run, "mid").nodes.find((n) => n.node_id === "stop_mid")).toMatchObject({
			status: "success",
			outputs: { status: "failed" },
		});
	});

	it("停止一个正在停止自己下级子流程的子流程：它的停止子流程节点记为已停止，外层等下级也结束后才成功", async () => {
		const id = await api.orchestrationWith(
			orchestration(
				[
					[entry(), spawn("spawn"), echo("load"), stop("stop", "mid"), echo("cleanup")],
					[
						subflowEntry("mid"),
						spawn("spawn_deep"),
						echo("work"),
						stop("stop_mid", "deep"),
						echo("next"),
					],
					[subflowEntry("deep"), echo("tail"), { ...echo("flush"), always: true }],
				],
				[
					["spawn", "mid"],
					["spawn_deep", "deep"],
				],
			),
		);
		const runId = await api.triggerOk(id);
		const first = await assigns(3);
		await agent.succeed(first.work as AssignedTask);
		expect((await agent.nextCancel()).taskId).toBe(first.tail?.taskId);

		await agent.succeed(first.load as AssignedTask);
		await agent.expectNoCancel();
		let run = await api.run(runId);
		expect(statuses(chainOf(run, "mid"))).toMatchObject({ stop_mid: "stopped", next: "stopped" });
		expect(chainOf(run, "mid").status).toBe("success");
		expect(stopNode(run)?.status).toBe("waiting");

		await agent.cancelled(first.tail as AssignedTask);
		const flush = await agent.nextAssign();
		expect(flush.nodeId).toBe("flush");
		await agent.succeed(flush);
		const cleanup = await agent.nextAssign();
		expect(cleanup.nodeId).toBe("cleanup");
		run = await api.run(runId);
		expect(stopNode(run)).toMatchObject({ status: "success", outputs: { status: "success" } });
		await agent.succeed(cleanup);
		expect((await api.run(runId)).status).toBe("success");
	});

	it("停止过程中取消运行：按取消的规则处理，已停止的保持不变；再次取消即强制取消，always 节点也立即终止", async () => {
		const id = await api.orchestrationWith(
			orchestration(
				[
					[
						entry(),
						spawn("spawn"),
						echo("load"),
						stop("stop", "mon"),
						echo("cleanup"),
						{ ...echo("final"), always: true },
					],
					[
						subflowEntry("mon"),
						spawn("spawn_deep"),
						echo("watch"),
						{ ...echo("flush"), always: true },
					],
					[
						subflowEntry("deep"),
						{ id: "nap", kind: "sleep", duration: "1h" },
						{ ...echo("flush_deep"), always: true },
					],
				],
				[
					["spawn", "mon"],
					["spawn_deep", "deep"],
				],
			),
		);
		const runId = await api.triggerOk(id);
		const first = await assigns(2);
		await agent.succeed(first.load as AssignedTask);
		expect(await agent.nextCancel()).toMatchObject({ taskId: first.watch?.taskId, force: false });
		const flushDeep = await agent.nextAssign();
		expect(flushDeep.nodeId).toBe("flush_deep");
		let run = await api.run(runId);
		expect(statuses(chainOf(run, "deep"))).toMatchObject({ nap: "stopped" });

		// 第一次取消：等待中的停止子流程节点与未开始的普通节点记为已取消，always 节点照常执行。
		await api.cancelOk(runId);
		expect(await agent.nextCancel()).toMatchObject({ taskId: first.watch?.taskId, force: false });
		const final = await agent.nextAssign();
		expect(final.nodeId).toBe("final");
		run = await api.run(runId);
		expect(statuses(chainOf(run, "entry"))).toMatchObject({
			stop: "cancelled",
			cleanup: "cancelled",
			final: "running",
		});
		expect(statuses(chainOf(run, "deep"))).toMatchObject({ nap: "stopped", flush_deep: "running" });

		// 再次取消：所有任务（含 always）立即取消；已经记为已停止的保持不变。
		await api.cancelOk(runId);
		expect(await cancels(3)).toEqual([first.watch?.taskId, flushDeep.taskId, final.taskId].sort());
		run = await api.run(runId);
		expect(run.status).toBe("cancelled");
		expect(statuses(chainOf(run, "entry"))).toMatchObject({
			stop: "cancelled",
			cleanup: "cancelled",
			final: "cancelled",
		});
		expect(statuses(chainOf(run, "mon"))).toEqual({
			mon: "success",
			spawn_deep: "success",
			watch: "cancelled",
			flush: "cancelled",
		});
		expect(statuses(chainOf(run, "deep"))).toEqual({
			deep: "success",
			nap: "stopped",
			flush_deep: "cancelled",
		});
	});

	it("运行被取消后才执行的 always 停止子流程节点：不再停止子流程，等它按取消结束，status 为 failed", async () => {
		const id = await api.orchestrationWith(
			orchestration(
				[
					[
						entry(),
						spawn("spawn"),
						echo("load"),
						stop("stop", "mon", { always: true }),
						echo("cleanup"),
					],
					[subflowEntry("mon"), echo("watch"), { ...echo("flush"), always: true }],
				],
				[["spawn", "mon"]],
			),
		);
		const runId = await api.triggerOk(id);
		const first = await assigns(2);
		await api.cancelOk(runId);
		expect(await cancels(2)).toEqual([first.load?.taskId, first.watch?.taskId].sort());
		await agent.cancelled(first.load as AssignedTask);
		await agent.expectNoCancel();
		let run = await api.run(runId);
		expect(stopNode(run)?.status).toBe("waiting");

		await agent.cancelled(first.watch as AssignedTask);
		const flush = await agent.nextAssign();
		expect(flush.nodeId).toBe("flush");
		await agent.succeed(flush);
		run = await api.run(runId);
		expect(statuses(chainOf(run, "mon"))).toEqual({
			mon: "success",
			watch: "cancelled",
			flush: "success",
		});
		expect(chainOf(run, "mon").status).toBe("cancelled");
		expect(stopNode(run)).toMatchObject({ status: "success", outputs: { status: "failed" } });
		expect(statuses(chainOf(run, "entry"))).toMatchObject({ cleanup: "cancelled" });
		expect(run.status).toBe("cancelled");
	});

	it("停止进行中重启控制面：Agent 重连后重新收到停止的取消指令，被停止的子流程和等待中的停止子流程节点照常完成", async () => {
		/** 模拟控制面崩溃重启：Agent 的连接断开，控制面在同一个数据库上重新启动，Agent 带着手上的任务重连。 */
		const restart = async (running: AssignedTask[]) => {
			await agent.disconnect();
			await cp.restart();
			agent = await FakeAgent.connect(cp.grpcUrl, {
				name: "agent-a",
				slots: 8,
				runningTasks: running.map((t) => ({ taskId: t.taskId, attempt: t.attempt })),
			});
		};
		const id = await api.orchestrationWith(
			orchestration(
				[
					[entry(), spawn("spawn"), echo("load"), stop("stop", "mon"), echo("cleanup")],
					[
						subflowEntry("mon"),
						spawn("spawn_deep"),
						echo("watch"),
						{ ...echo("flush"), always: true },
					],
					[subflowEntry("deep"), echo("tail"), echo("after")],
				],
				[
					["spawn", "mon"],
					["spawn_deep", "deep"],
				],
			),
		);
		const runId = await api.triggerOk(id);
		const first = await assigns(3);
		await agent.succeed(first.load as AssignedTask);
		expect(await cancels(2)).toEqual([first.watch?.taskId, first.tail?.taskId].sort());

		// 取消指令可能随断开的连接丢失：重连后重新发出。
		await restart([first.watch as AssignedTask, first.tail as AssignedTask]);
		expect(await cancels(2)).toEqual([first.watch?.taskId, first.tail?.taskId].sort());
		let run = await api.run(runId);
		expect(stopNode(run)?.status).toBe("waiting");
		await agent.cancelled(first.watch as AssignedTask);
		const flush = await agent.nextAssign();
		expect(flush.nodeId).toBe("flush");

		// 停止子流程节点在等子流程的 always 节点和下级子流程时重启：重启后照常等待、完成。
		await restart([flush, first.tail as AssignedTask]);
		expect((await agent.nextCancel()).taskId).toBe(first.tail?.taskId);
		await agent.succeed(flush);
		run = await api.run(runId);
		expect(stopNode(run)?.status).toBe("waiting");
		await agent.expectNoAssign();
		await agent.cancelled(first.tail as AssignedTask);
		const cleanup = await agent.nextAssign();
		expect(cleanup.nodeId).toBe("cleanup");
		await agent.succeed(cleanup);
		run = await api.run(runId);
		expect(statuses(chainOf(run, "mon"))).toMatchObject({ watch: "stopped", flush: "success" });
		expect(statuses(chainOf(run, "deep"))).toEqual({
			deep: "success",
			tail: "stopped",
			after: "stopped",
		});
		expect(stopNode(run)).toMatchObject({ status: "success", outputs: { status: "success" } });
		expect(run.status).toBe("success");
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

	it("指向自己所在的链、上级链或其他分支上的子流程时保存成功但返回警告，触发被拒绝", async () => {
		const id = await api.createOrchestration("停止子流程范围");
		// 主链触发 a、b 两个分支，a 再触发 deep；stopper 放在 chain 链末尾，停止 target。
		const doc = (chain: "a" | "deep", target: string) =>
			orchestration(
				[
					[entry(), spawn("spawn_a"), spawn("spawn_b")],
					[
						subflowEntry("a"),
						spawn("spawn_deep"),
						...(chain === "a" ? [stop("stop", target)] : []),
					],
					[subflowEntry("b"), echo("watch_b")],
					[subflowEntry("deep"), ...(chain === "deep" ? [stop("stop", target)] : [])],
				],
				[
					["spawn_a", "a"],
					["spawn_b", "b"],
					["spawn_deep", "deep"],
				],
			);
		const check = async (document: unknown) => {
			const saved = await api.post(`/orchestrations/${id}/versions`, {
				base_version: await api.headVersion(id),
				document,
			});
			expect(saved.status).toBe(201);
			const { warnings } = (await saved.json()) as {
				warnings: { code: string; node_id?: string }[];
			};
			const res = await api.trigger(id);
			expect(res.status).toBe(400);
			const { error } = (await res.json()) as {
				error: { details: { code: string; node_id?: string }[] };
			};
			return {
				warnings: warnings.map((w) => [w.code, w.node_id]),
				problems: error.details.map((p) => [p.code, p.node_id]),
			};
		};
		const outOfScope = {
			warnings: [["stop_subflow_out_of_scope", "stop"]],
			problems: [["stop_subflow_out_of_scope", "stop"]],
		};

		expect(await check(doc("a", "a"))).toEqual(outOfScope); // 自己所在的链
		expect(await check(doc("deep", "a"))).toEqual(outOfScope); // 上级链
		expect(await check(doc("a", "b"))).toEqual(outOfScope); // 其他分支
	});
});
