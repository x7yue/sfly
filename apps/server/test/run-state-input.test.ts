// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 引用语法就是 ${{ ... }}，不是模板字符串
// 切入点 A：节点输入里的运行状态 `${{ run.state }}`（docs/SEMANTICS.md §2.7，ADR 0031）。
// HTTP API + 讲真实 gRPC 的假 Agent + 手动时钟 + 独立的 PostgreSQL；通过派发给 Agent 的输入和运行视图观察。
import { RUN_STATE_LIMITS, RunState } from "@sfly/schema";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runStateForDispatch } from "../src/runs/run-state-source.js";
import { ApiClient } from "./support/api-client.js";
import { echo, orchestration, spawn } from "./support/chains.js";
import { eventually } from "./support/eventually.js";
import { type AssignedTask, ErrorKind, FakeAgent } from "./support/fake-agent.js";
import type { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { singleConnection } from "./support/single-connection.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

type Node = Record<string, unknown> & { id: string };

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const STACK =
	'Traceback (most recent call last):\n  File "check.py", line 7, in run\nValueError: x';
const TOKEN = "tk-secret-123";

/** 汇总节点：包 `report` 的 `run_summary`，`run` 输入是用 `sfly.RunState` 声明的（`x-sfly-type: run_state`）。 */
const summary = (id: string, extra: Record<string, unknown> = {}): Node => ({
	id,
	kind: "package",
	package: "report",
	node: "run_summary",
	always: true,
	inputs: { run: "${{ run.state }}" },
	...extra,
});

/** 入口加给定的节点串成的单链；入口声明一个保密参数 token。 */
function flow(nodes: Node[]) {
	const all: Node[] = [
		{
			id: "entry",
			kind: "entry",
			params: [{ name: "token", type: "string", default: TOKEN, secret: true }],
		},
		...nodes,
	];
	return {
		default_agent: "agent-a",
		nodes: all,
		edges: all.slice(1).map((n, i) => ({ from: all[i]?.id, to: n.id, kind: "chain" })),
		packages: { stub: "1.0.0", report: "1.0.0" },
	};
}

describe("节点输入里的运行状态 ${{ run.state }}", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let agent: FakeAgent;
	const clock = () => cp.clock as ManualClock;

	beforeEach(async () => {
		cp = await startTestControlPlane({ leaseMs: 60 * 60_000 });
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
		await publishPackage(cp, "report", "1.0.0", {
			run_summary: {
				outputs: [],
				inputs: {
					properties: { run: { type: "object", "x-sfly-type": "run_state" } },
					required: ["run"],
				},
			},
		});
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 8 }, { clock: cp.clock });
	});
	afterEach(async () => {
		await agent.disconnect();
		await cp.close();
	});

	const start = async (document: unknown) => api.triggerOk(await api.orchestrationWith(document));
	/** 派发给汇总节点的运行状态（按 schema 校验）。 */
	const stateOf = (task: AssignedTask): RunState => RunState.parse(task.inputs.run);
	const nodeOf = (state: RunState, nodeId: string) =>
		state.chains.flatMap((c) => c.nodes).find((n) => n.node_id === nodeId);

	it("总是执行的汇总节点收到整个运行的状态：失败的节点、原因、被跳过的节点，自己是 dispatched；保密参数的值已打码", async () => {
		const runId = await start(flow([echo("a"), echo("b"), echo("c"), summary("sum")]));
		await agent.succeed(await agent.nextAssign());
		const b = await agent.nextAssign();
		clock().advance(3_000);
		await agent.fail(b, `ValueError: ${TOKEN} 无效\n\n${STACK}`, ErrorKind.NODE_ERROR);

		const task = await agent.nextAssign();
		expect(task.nodeId).toBe("sum");
		const state = stateOf(task);
		expect(state).toMatchObject({
			run_id: runId,
			scenario: { name: "test", version: 1 },
			status: "running",
			result_so_far: "failed",
			triggered_by: "tester",
			cancel: null,
			failures: ["b"],
			self: { chain_instance_id: state.chains[0]?.id, node_id: "sum" },
			truncated: false,
		});
		expect(state.chains).toHaveLength(1);
		expect(state.chains[0]).toMatchObject({ depth: 0, name: null, status: "running" });
		expect(state.chains[0]?.nodes.map((n) => [n.node_id, n.status, n.attempts])).toEqual([
			["entry", "success", 1],
			["a", "success", 1],
			["b", "failed", 1],
			["c", "skipped", 0],
			["sum", "dispatched", 1],
		]);
		expect(nodeOf(state, "b")).toMatchObject({
			started_at: iso(T0),
			ended_at: iso(T0 + 3_000),
			error: {
				kind: "node_error",
				headline: "ValueError: ****** 无效",
				message: "ValueError: ****** 无效",
				message_truncated: false,
				location: null,
			},
		});
		expect(nodeOf(state, "c")).toMatchObject({ error: null, started_at: null });
		expect(nodeOf(state, "sum")).toMatchObject({ started_at: null, ended_at: null, error: null });
		// 保密参数的值打了码，不管在节点收到的输入里，还是记在这次尝试上、运行视图里读到的。
		expect(JSON.stringify(task.inputs)).not.toContain(TOKEN);
		const recorded = (await api.node(runId, "sum")).attempts[0]?.inputs;
		expect(recorded).toEqual(task.inputs);
		expect(JSON.stringify(recorded)).not.toContain(TOKEN);
	});

	describe("保密参数的值打码：和运行摘要同一个口径（readRuns 的读取时打码）", () => {
		const LATER = "later-pw-3f9d2a71";

		/**
		 * 主链 entry → spawn0（子流程「前」，里面有 x）→ gate → spawn1（子流程「后」，保密参数 pw 的值 LATER 由它传入）→ sum。
		 * 子流程「前」的 x 失败时，LATER 还不是这次运行的保密参数的值：错误信息存进库时没有打码，
		 * 子流程「后」创建出来之后，读取时按这次运行此刻的保密参数的值再打码。
		 */
		const document = () => {
			const doc = orchestration(
				[
					[
						{ id: "entry", kind: "entry", params: [] },
						spawn("spawn0"),
						echo("gate"),
						spawn("spawn1", { pw: LATER }),
						summary("sum"),
					],
					[{ id: "sub0", kind: "subflow_entry", name: "前", params: [] }, echo("x")],
					[
						{
							id: "sub1",
							kind: "subflow_entry",
							name: "后",
							params: [{ name: "pw", type: "string", secret: true }],
						},
						echo("y"),
					],
				],
				[
					["spawn0", "sub0"],
					["spawn1", "sub1"],
				],
			);
			return { ...doc, packages: { ...doc.packages, report: "1.0.0" } };
		};

		it("子流程创建之前失败的节点：错误信息、失败原因、出错位置里的值，汇总节点收到的是掩码，记在任务上的输入里也搜不到原值", async () => {
			const runId = await start(document());
			// spawn0 成功之后子流程「前」的 x 和主链的 gate 同时派发。
			const first = [await agent.nextAssign(), await agent.nextAssign()];
			const x = first.find((t) => t.nodeId === "x") as AssignedTask;
			const gate = first.find((t) => t.nodeId === "gate") as AssignedTask;
			await agent.fail(
				x,
				`连接口令 ${LATER} 无效\n\n${STACK}`,
				ErrorKind.NODE_ERROR,
				undefined,
				`probe.connect 第 7 行（${LATER}）`,
			);
			// gate 成功之后 spawn1 把 LATER 传给子流程「后」，子流程「后」的第一个节点 y 和汇总节点同时派发。
			await agent.succeed(gate);
			const second = [await agent.nextAssign(), await agent.nextAssign()];
			const sum = second.find((t) => t.nodeId === "sum") as AssignedTask;

			const state = stateOf(sum);
			// 两个子流程同一时刻创建（手动时钟），先后只由 ID 决定，这里不看顺序。
			expect(state.chains.map((c) => c.name).sort()).toEqual([null, "前", "后"].sort());
			expect(state.failures).toEqual(["x"]);
			expect(nodeOf(state, "x")?.error).toEqual({
				kind: "node_error",
				headline: "连接口令 ****** 无效",
				message: "连接口令 ****** 无效",
				message_truncated: false,
				location: "probe.connect 第 7 行（******）",
			});
			expect(JSON.stringify(sum.inputs)).not.toContain(LATER);
			const recorded = (await api.node(runId, "sum")).attempts[0]?.inputs;
			expect(recorded).toEqual(sum.inputs);
			expect(JSON.stringify(recorded)).not.toContain(LATER);
		});
	});

	it("没有引用 run.state 的输入原样不变；引用只对写了它的节点解析", async () => {
		await start(flow([echo("a", { v: "x" }), summary("sum")]));
		const a = await agent.nextAssign();
		expect(a.inputs).toEqual({ v: "x" });
		await agent.succeed(a);
		expect(Object.keys((await agent.nextAssign()).inputs)).toEqual(["run"]);
	});

	it("超时的节点是 failed、类型是 timeout；被取消的节点是 cancelled、没有错误，取消人和时间在 cancel 里，结果是 cancelled", async () => {
		const id = await api.orchestrationWith(flow([echo("a"), echo("b"), summary("sum")]));
		const runId = await api.triggerOk(id);
		const a = await agent.nextAssign();
		await agent.fail(a, "任务超时", ErrorKind.TIMEOUT);
		const timedOut = stateOf(await agent.nextAssign());
		expect(nodeOf(timedOut, "a")).toMatchObject({
			status: "failed",
			error: { kind: "timeout", headline: "任务超时", message: "任务超时" },
		});
		expect(timedOut).toMatchObject({ result_so_far: "failed", failures: ["a"] });
		expect(runId).toBeTruthy();

		// 另一次运行：取消。
		const second = await api.triggerOk(id);
		const first = await agent.nextAssign();
		expect(first.nodeId).toBe("a");
		clock().advance(2_000);
		await api.cancelOk(second);
		await agent.nextCancel();
		await agent.cancelled(first);
		const task = await agent.nextAssign();
		expect(task.nodeId).toBe("sum");
		const state = stateOf(task);
		expect(state).toMatchObject({
			status: "running",
			result_so_far: "cancelled",
			failures: [],
			cancel: {
				requested_by: "tester",
				requested_via: null,
				requested_at: iso(T0 + 2_000),
				forced_at: null,
			},
		});
		expect(nodeOf(state, "a")).toMatchObject({ status: "cancelled", error: null });
		expect(nodeOf(state, "b")).toMatchObject({ error: null });
		expect(["cancelled", "skipped"]).toContain(nodeOf(state, "b")?.status);
	});

	it("重试时每次尝试各解析一次：第二次尝试里自己的尝试次数是 2，第一次的失败也在里面", async () => {
		const runId = await start(flow([echo("a"), summary("sum", { retries: 1 })]));
		await agent.succeed(await agent.nextAssign());
		const first = await agent.nextAssign();
		expect(stateOf(first).chains[0]?.nodes.find((n) => n.node_id === "sum")).toMatchObject({
			status: "dispatched",
			attempts: 1,
		});
		await agent.fail(first, "汇总第一次失败");
		const second = await agent.nextAssign();
		expect(second).toMatchObject({ nodeId: "sum", attempt: 2 });
		const state = stateOf(second);
		expect(nodeOf(state, "sum")).toMatchObject({ status: "dispatched", attempts: 2 });
		// 汇总节点自己第一次失败了：它是引用者，状态按这次尝试给 dispatched，失败的原因在最终失败以后才有。
		expect(state.failures).toEqual([]);
		// 两次尝试各记各的输入。
		const attempts = (await api.node(runId, "sum")).attempts;
		expect(attempts.map((t) => (t.inputs?.run as RunState | undefined)?.self?.node_id)).toEqual([
			"sum",
			"sum",
		]);
		expect(
			attempts.map(
				(t) =>
					(t.inputs?.run as RunState).chains[0]?.nodes.find((n) => n.node_id === "sum")?.attempts,
			),
		).toEqual([1, 2]);
	});

	describe("范围和调度", () => {
		/** 主链 entry → a → x(异步任务节点，触发子流程) → [middle…] → sum；子流程 sub → s1 → s2。 */
		const document = (middle: Node[] = []) => {
			const doc = orchestration(
				[
					[
						{
							id: "entry",
							kind: "entry",
							params: [{ name: "token", type: "string", default: TOKEN, secret: true }],
						},
						echo("a"),
						spawn("x", {}),
						...middle,
						summary("sum"),
					],
					[
						{ id: "sub", kind: "subflow_entry", name: "子流程", params: [] },
						echo("s1"),
						echo("s2"),
					],
				],
				[["x", "sub"]],
			);
			return { ...doc, packages: { ...doc.packages, report: "1.0.0" } };
		};

		it("汇总节点看到已触发的子流程实例；不等待还在进行的子流程（引用不构成对任何节点的依赖）", async () => {
			await start(document());
			await agent.succeed(await agent.nextAssign());
			// 异步任务节点成功之后汇总节点马上派发，子流程的第一个节点同时派发，子流程还在进行。
			const tasks = [await agent.nextAssign(), await agent.nextAssign()];
			const sum = tasks.find((t) => t.nodeId === "sum");
			expect(sum).toBeDefined();
			const state = stateOf(sum as AssignedTask);
			expect(state.chains.map((c) => [c.name, c.depth, c.status])).toEqual([
				[null, 0, "running"],
				["子流程", 1, "running"],
			]);
			expect(state.chains[1]).toMatchObject({
				parent_chain_instance_id: state.chains[0]?.id,
				async_node_id: "x",
			});
			expect(nodeOf(state, "x")).toMatchObject({ status: "success" });
			expect(nodeOf(state, "s1")).toMatchObject({ status: "dispatched", attempts: 1 });
			expect(nodeOf(state, "s2")).toMatchObject({ status: "pending", attempts: 0 });
			expect(state.failures).toEqual([]);
		});

		it("子流程里失败的节点，主链末尾的汇总节点也看得到：failures 里有它，原因在子流程那条链的节点上", async () => {
			const runId = await start(document([echo("w")]));
			await agent.succeed(await agent.nextAssign());
			const tasks = [await agent.nextAssign(), await agent.nextAssign()];
			const w = tasks.find((t) => t.nodeId === "w") as AssignedTask;
			const s1 = tasks.find((t) => t.nodeId === "s1") as AssignedTask;
			await agent.fail(s1, `子流程里的 ${TOKEN} 失败\n\n${STACK}`, ErrorKind.NODE_ERROR);
			await agent.succeed(w);

			const task = await agent.nextAssign();
			expect(task.nodeId).toBe("sum");
			const state = stateOf(task);
			expect(state).toMatchObject({ result_so_far: "failed", failures: ["s1"] });
			expect(state.chains[1]).toMatchObject({ name: "子流程", status: "failed" });
			expect(nodeOf(state, "s1")).toMatchObject({
				status: "failed",
				error: { kind: "node_error", headline: "子流程里的 ****** 失败" },
			});
			expect(nodeOf(state, "s2")).toMatchObject({ status: "skipped" });
			// 主链自己还在进行（汇总节点是它的最后一个节点）。
			expect(state.chains[0]?.status).toBe("running");
			expect(JSON.stringify(task.inputs)).not.toContain(TOKEN);
			expect(runId).toBeTruthy();
		});

		it("放在停止子流程节点之后：看到的那个子流程是已结束的状态", async () => {
			const stop: Node = { id: "stop", kind: "stop_subflow", subflow: "sub", always: false };
			await start(document([echo("w"), stop]));
			await agent.succeed(await agent.nextAssign());
			// 子流程的第一个节点和主链上的 w 同时派发；w 成功之后停止子流程节点取消正在进行的子流程，子流程结束了才往下走。
			const tasks = [await agent.nextAssign(), await agent.nextAssign()];
			const w = tasks.find((t) => t.nodeId === "w") as AssignedTask;
			const s1 = tasks.find((t) => t.nodeId === "s1") as AssignedTask;
			await agent.succeed(w);
			await agent.nextCancel();
			await agent.cancelled(s1);
			const task = await agent.nextAssign();
			expect(task.nodeId).toBe("sum");
			const state = stateOf(task);
			expect(state.chains[1]?.status).not.toBe("running");
			expect(nodeOf(state, "stop")).toMatchObject({ status: "success" });
			expect(["cancelled", "stopped"]).toContain(nodeOf(state, "s1")?.status);
			expect(nodeOf(state, "s1")?.error).toBeNull();
			expect(state.failures).toEqual([]);
		});

		it("异步任务节点的参数映射里引用 run.state：触发前的预检阻断，写明怎么改", async () => {
			const doc = orchestration(
				[
					[{ id: "entry", kind: "entry", params: [] }, spawn("x", { run: "${{ run.state }}" })],
					[
						{
							id: "sub",
							kind: "subflow_entry",
							name: "子流程",
							params: [{ name: "run", type: "json" }],
						},
						echo("s1"),
					],
				],
				[["x", "sub"]],
			);
			const id = await api.orchestrationWith(doc);
			const res = await api.trigger(id);
			expect(res.status).toBe(400);
			const body = (await res.json()) as {
				error: {
					code: string;
					details: Array<{ code: string; message: string; node_id?: string }>;
				};
			};
			expect(body.error.code).toBe("invalid_orchestration");
			expect(body.error.details.map((d) => [d.code, d.node_id])).toEqual([
				["reference_run_state_misplaced", "x"],
			]);
			expect(body.error.details[0]?.message).toContain("参数映射在子流程创建时解析并按值复制");
		});

		it("保存时只警告、仍然保存：每种写法有各自的警告，指着节点和输入", async () => {
			const warningsOf = async (document: unknown) => {
				const id = await api.createOrchestration("保存警告");
				const res = await api.post(`/orchestrations/${id}/versions`, {
					base_version: await api.headVersion(id),
					document,
				});
				expect(res.status, await res.clone().text()).toBe(201);
				return (
					(await res.json()) as {
						warnings: Array<{ code: string; node_id?: string; input?: string }>;
					}
				).warnings // 只看 run.state 的警告：场景里别的警告（例如保密参数写了默认值）和这里无关。
					.filter((w) => /^(reference|input)_run_state_/.test(w.code))
					.map((w) => [w.code, w.node_id, w.input]);
			};
			expect(
				await warningsOf(flow([echo("e", { v: "状态 ${{ run.state }}" }), summary("sum")])),
			).toEqual([["reference_run_state_embedded", "e", "v"]]);
			expect(await warningsOf(flow([summary("sum", { inputs: {} })]))).toEqual([
				["input_run_state_missing", "sum", "run"],
			]);
			expect(await warningsOf(flow([summary("sum", { inputs: { run: "字面值" } })]))).toEqual([
				["input_run_state_value", "sum", "run"],
			]);
			expect(await warningsOf(flow([summary("sum")]))).toEqual([]);
		});

		it("夹在文字里、RunState 输入没接或接了别的值：预检阻断", async () => {
			for (const [inputs, code] of [
				[{ run: "状态 ${{ run.state }}" }, "input_run_state_value"],
				[{}, "input_run_state_missing"],
				[{ run: "字面值" }, "input_run_state_value"],
			] as const) {
				const id = await api.orchestrationWith(flow([summary("sum", { inputs })]));
				const res = await api.trigger(id);
				expect(res.status, JSON.stringify(inputs)).toBe(400);
				const body = (await res.json()) as { error: { details: Array<{ code: string }> } };
				expect(body.error.details.map((d) => d.code)).toEqual([code]);
			}
			const embedded = flow([echo("e", { v: "状态 ${{ run.state }}" })]);
			const id = await api.orchestrationWith(embedded);
			const res = await api.trigger(id);
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: { details: Array<{ code: string }> } };
			expect(body.error.details.map((d) => d.code)).toEqual(["reference_run_state_embedded"]);
		});
	});

	describe("读取的次数", () => {
		/** 记下经 pg 客户端发出的、读运行状态的查询（`readRuns` 的 `state` 档：选了任务的错误列、不选输入和输出）。 */
		function spyStateReads() {
			const original = pg.Client.prototype.query;
			const statements: string[] = [];
			pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
				const first = args[0];
				const text = typeof first === "string" ? first : (first as { text?: string })?.text;
				if (
					text?.includes('"error_kind"') &&
					text.includes('from "tasks"') &&
					!text.includes('"inputs"')
				) {
					statements.push(text);
				}
				return (original as (...a: unknown[]) => unknown).apply(this, args);
			} as typeof pg.Client.prototype.query;
			return {
				reads: () => statements.length,
				statements,
				restore: () => {
					pg.Client.prototype.query = original;
				},
			};
		}

		it("没有引用 run.state 的节点派发时不读运行状态；引用了的节点每次尝试读一次", async () => {
			const spy = spyStateReads();
			try {
				await start(flow([echo("a"), echo("b"), summary("sum")]));
				await agent.succeed(await agent.nextAssign());
				// b 已经派发出去，汇总节点还在等 b。
				const b = await agent.nextAssign();
				expect(b.nodeId).toBe("b");
				expect(spy.statements, spy.statements.join("\n---\n")).toHaveLength(0);
				await agent.succeed(b);
				const task = await agent.nextAssign();
				expect(task.nodeId).toBe("sum");
				expect(spy.reads()).toBe(1);
			} finally {
				spy.restore();
			}
		});

		it("读一次运行状态的查询次数与运行里的节点数无关，查询一条接一条地执行", async () => {
			const queriesFor = async (count: number) => {
				const nodes = Array.from({ length: count }, (_, i) => echo(`n${i + 1}`));
				const runId = await start(flow([...nodes, summary("sum")]));
				for (let i = 0; i < count; i++) await agent.succeed(await agent.nextAssign());
				await agent.nextAssign();
				const single = singleConnection(cp.database.url);
				try {
					const chain = (await api.run(runId)).chains[0]?.id ?? "";
					// 单连接的库不能有别的在写：测试里的控制面是另一个连接池，这里只读。
					const before = single.queryCount();
					const state = await runStateForDispatch(single.db, runId, {
						chain_instance_id: chain,
						node_id: "sum",
					});
					expect(state.chains[0]?.nodes).toHaveLength(count + 2);
					expect(single.mostPending()).toBe(1);
					return single.queryCount() - before;
				} finally {
					await single.end();
				}
			};
			const small = await queriesFor(2);
			const big = await queriesFor(25);
			expect(small).toBeGreaterThan(0);
			expect(big).toBe(small);
		});

		it("引用 run.state 的节点和没引用的节点，就绪和派发的时机相同：前一个节点成功之后马上派发", async () => {
			const plain = await start(flow([echo("a"), echo("b")]));
			const withState = await start(flow([echo("a"), summary("sum")]));
			const firsts = [await agent.nextAssign(), await agent.nextAssign()];
			for (const task of firsts) await agent.succeed(task);
			const nexts = [await agent.nextAssign(), await agent.nextAssign()];
			expect(nexts.map((t) => t.nodeId).sort()).toEqual(["b", "sum"]);
			// 两个下一个节点派发时的排队、派发时间相同（手动时钟没有走）。
			const attempt = async (runId: string, node: string) =>
				(await api.node(runId, node)).attempts[0];
			const [b, sum] = await Promise.all([attempt(plain, "b"), attempt(withState, "sum")]);
			expect(b?.status).toBe(sum?.status);
			expect(b?.queued_at).toBe(sum?.queued_at);
			expect(b?.started_at).toBe(sum?.started_at);
			await eventually(async () => expect((await api.run(plain)).status).toBe("running"));
		});
	});

	describe("准备这个任务的派发内容时出错：只有这个任务以 config_error 失败，不卡住这台 Agent 上别的任务", () => {
		/**
		 * 经 pg 客户端发出的语句里满足 `match` 的（开关打开之后的前 `times` 条）按 `how` 失败：
		 * `js` 抛 JS 错误（语句没发出去），`db` 发一条会出错的语句（事务随之中止）。
		 */
		function failQueries(match: (text: string) => boolean, how: "js" | "db", times = 1) {
			const original = pg.Client.prototype.query;
			const state = { on: false, failed: 0 };
			pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
				const first = args[0];
				const text = (typeof first === "string" ? first : (first as { text?: string })?.text) ?? "";
				if (state.on && state.failed < times && match(text)) {
					state.failed++;
					if (how === "js") return Promise.reject(new Error("injected: 读取失败"));
					return (original as (...a: unknown[]) => Promise<unknown>).call(this, "select 1/0");
				}
				return (original as (...a: unknown[]) => unknown).apply(this, args);
			} as typeof pg.Client.prototype.query;
			return {
				state,
				restore: () => {
					pg.Client.prototype.query = original;
				},
			};
		}
		/** 读运行状态的查询（`readRuns` 的 `state` 档：选了任务的错误列、不选输入和输出）。 */
		const readsRunState = (text: string) =>
			text.includes('"error_kind"') && text.includes('from "tasks"') && !text.includes('"inputs"');
		/** 派发时读节点包元信息的查询（assign-content.ts）。 */
		const readsPackage = (text: string) =>
			text.includes('from "node_packages"') &&
			text.includes('"sha256"') &&
			text.includes('"metadata"');

		/** agent-b 注册之后离线：任务派给它会先排队，重连的那一刻在同一个派发的事务里按排队顺序处理。 */
		const registerOffline = async () => {
			await (
				await FakeAgent.connect(cp.grpcUrl, { name: "agent-b", slots: 4 }, { clock: cp.clock })
			).close();
			await eventually(async () => {
				const { agents } = await api.getJson<{ agents: { name: string; status: string }[] }>(
					"/agents",
				);
				expect(agents.find((a) => a.name === "agent-b")?.status).toBe("offline");
			});
		};
		const onB = (nodes: Node[]) => ({ ...flow(nodes), default_agent: "agent-b" });
		const extra: FakeAgent[] = [];
		afterEach(async () => {
			await Promise.all(extra.splice(0).map((a) => a.disconnect()));
		});

		it("读运行状态时出错（数据库报错，事务随之中止）：这个任务以 config_error 失败，写明是解析 run.state 出的错和原因；排在它后面的任务照常派发；下一次扫描不再重试它", async () => {
			await registerOffline();
			const failing = await start(onB([summary("sum")]));
			const follower = await start(onB([echo("b1")]));
			const inject = failQueries(readsRunState, "db");
			try {
				inject.state.on = true;
				const b = await FakeAgent.connect(
					cp.grpcUrl,
					{ name: "agent-b", slots: 4 },
					{ clock: cp.clock },
				);
				extra.push(b);
				// 同一个事务里先处理的是汇总节点（它先排队），它失败之后 b1 照常派发。
				const task = await b.nextAssign();
				expect(task.runId).toBe(follower);
				expect(task.nodeId).toBe("b1");

				const sum = await api.node(failing, "sum");
				expect(sum.attempts.map((a) => [a.attempt, a.status, a.error?.kind])).toEqual([
					[1, "failed", "config_error"],
				]);
				const message = sum.attempts[0]?.error?.message ?? "";
				expect(message).toContain("解析 ${{ run.state }} 失败");
				expect(message).toContain("division by zero");
				expect(inject.state.failed).toBe(1);

				// 下一次扫描（别的运行触发的派发）不再碰它：不重试，也不再读。
				const another = await start(onB([echo("b2")]));
				const next = await b.nextAssign();
				expect([next.runId, next.nodeId]).toEqual([another, "b2"]);
				expect(inject.state.failed).toBe(1);
				expect((await api.node(failing, "sum")).attempts).toHaveLength(1);
			} finally {
				inject.restore();
			}
		});

		it("准备派发内容时别的步骤出错（读节点包元信息抛错）：同样只让这个任务以 config_error 失败，写明原因，后面的任务照常派发", async () => {
			await registerOffline();
			const failing = await start(onB([echo("a1")]));
			const follower = await start(onB([echo("b1")]));
			const inject = failQueries(readsPackage, "js", 1);
			try {
				inject.state.on = true;
				const b = await FakeAgent.connect(
					cp.grpcUrl,
					{ name: "agent-b", slots: 4 },
					{ clock: cp.clock },
				);
				extra.push(b);
				// 同一个事务里先处理的 a1 失败，b1 照常派发。
				const task = await b.nextAssign();
				expect([task.runId, task.nodeId]).toEqual([follower, "b1"]);
				const a1 = (await api.node(failing, "a1")).attempts;
				expect(a1.map((a) => [a.attempt, a.status, a.error?.kind])).toEqual([
					[1, "failed", "config_error"],
				]);
				expect(a1[0]?.error?.message).toContain("准备派发内容时出错");
				expect(a1[0]?.error?.message).toContain("injected: 读取失败");
				expect(inject.state.failed).toBe(1);
			} finally {
				inject.restore();
			}
		});
	});

	describe("整份运行状态去掉全部错误信息之后仍然放不下", () => {
		it("这个节点不派发，任务以 config_error 失败，写明运行状态有多大、上限多少、有多少个节点；不再做第二层裁剪", async () => {
			const runId = await start(flow([echo("a"), echo("b"), summary("sum")]));
			await agent.succeed(await agent.nextAssign());
			await agent.fail(await agent.nextAssign(), `ValueError: x\n\n${STACK}`, ErrorKind.NODE_ERROR);
			const sumTask = await agent.nextAssign();
			expect(sumTask.nodeId).toBe("sum");
			const single = singleConnection(cp.database.url);
			try {
				const chain = (await api.run(runId)).chains[0]?.id ?? "";
				const self = { chain_instance_id: chain, node_id: "sum" };
				// 正常的上限放得下；把上限压得很小，去掉全部错误信息之后也放不下。
				await expect(runStateForDispatch(single.db, runId, self)).resolves.toMatchObject({
					failures: ["b"],
				});
				const small = { ...RUN_STATE_LIMITS, bytes: 600 };
				const error = await runStateForDispatch(single.db, runId, self, small).catch((e) => e);
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toMatch(
					/^解析 \$\{\{ run\.state \}\} 失败：运行状态有 \d+(\.\d+)? KB（4 个节点、1 个链实例），去掉全部错误信息之后仍然超过上限 \d+(\.\d+)? KB/,
				);
			} finally {
				await single.end();
			}
		});
	});
});
