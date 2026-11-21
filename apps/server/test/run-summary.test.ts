// 切入点 A：运行摘要 GET /runs/:id/summary（#423）。真实控制面 + 讲真实 gRPC 的假 Agent + 手动时钟 + 独立的
// PostgreSQL，通过 HTTP 接口观察：成功、节点失败、重试后成功、取消、还在执行的运行，保密参数打码，日志尾部、失败的动作、
// 有异常的关注项，数量上限。

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { type RunReport, runSummaryApi } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { echo as chainEcho, orchestration, spawn } from "./support/chains.js";
import { eventually } from "./support/eventually.js";
import {
	type AssignedTask,
	ErrorKind,
	FakeAgent,
	LogLevel,
	LogSource,
} from "./support/fake-agent.js";
import { benchDocument, publishBench, putFocusItemsOk } from "./support/focus-items.js";
import type { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { IDS, seedRemovedKindScenario } from "./support/removed-kind-scenario.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

type Node = Record<string, unknown> & { id: string };
const echo = (id: string, extra: Record<string, unknown> = {}): Node => ({
	id,
	kind: "package",
	package: "stub",
	node: "echo",
	inputs: {},
	...extra,
});

/** 入口加若干包节点串成的单链；入口声明一个保密参数 `token`。 */
function flow(nodes: Node[]) {
	const all: Node[] = [
		{
			id: "entry",
			kind: "entry",
			params: [{ name: "token", type: "string", default: "tk-secret", secret: true }],
		},
		...nodes,
	];
	return {
		default_agent: "agent-a",
		nodes: all,
		edges: all.slice(1).map((n, i) => ({ from: all[i]?.id, to: n.id, kind: "chain" })),
		packages: { stub: "1.0.0" },
	};
}

const STACK =
	'Traceback (most recent call last):\n  File "check.py", line 7, in run\nValueError: 余额不足';

describe("运行摘要", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let agent: FakeAgent;
	const clock = () => cp.clock as ManualClock;

	beforeEach(async () => {
		cp = await startTestControlPlane({ leaseMs: 60 * 60_000 });
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
		await publishBench(cp);
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 4 }, { clock: cp.clock });
	});
	afterEach(async () => {
		await agent.disconnect();
		await cp.close();
	});

	const summaryRes = (runId: string) => cp.fetch(`/runs/${runId}/summary`);
	const summary = async (runId: string): Promise<RunReport> => {
		const res = await summaryRes(runId);
		expect(res.status, await res.clone().text()).toBe(200);
		return runSummaryApi.summary.response.parse(await res.json());
	};
	const start = async (document: unknown) => api.triggerOk(await api.orchestrationWith(document));
	const node = (report: RunReport, nodeId: string) =>
		report.chains.flatMap((c) => c.nodes).find((n) => n.node_id === nodeId);
	/** 等任务的日志写完（写到第 `seq` 行）。 */
	const logsWritten = (task: AssignedTask, seq: number) =>
		eventually(async () => {
			const res = await cp.fetch(`/tasks/${task.taskId}/logs?limit=1`);
			expect(((await res.json()) as { last_seq: number }).last_seq).toBe(seq);
		});

	it("成功的运行：状态、耗时、每个节点的状态和尝试，没有失败的任务、动作和关注项", async () => {
		const runId = await start(flow([echo("a"), echo("b")]));
		clock().advance(5_000);
		await agent.succeed(await agent.nextAssign());
		clock().advance(7_000);
		await agent.succeed(await agent.nextAssign());

		const report = await summary(runId);
		expect(report).toMatchObject({
			run_id: runId,
			scenario: { name: "test", version: 1 },
			status: "success",
			result_so_far: "success",
			triggered_by: "tester",
			triggered_via: null,
			started_at: iso(T0),
			ended_at: iso(T0 + 12_000),
			duration_ms: 12_000,
			cancel: null,
			failures: [],
			self: null,
			truncated: false,
			failed_tasks: [],
			failed_tasks_total: 0,
			failed_actions: [],
			attention_items: [],
		});
		expect(report.chains).toHaveLength(1);
		expect(report.chains[0]).toMatchObject({ depth: 0, name: null, status: "success" });
		expect(node(report, "a")).toMatchObject({
			kind: "package",
			status: "success",
			attempts: 1,
			started_at: iso(T0 + 5_000),
			ended_at: iso(T0 + 5_000),
			error: null,
		});
		expect(node(report, "b")).toMatchObject({ status: "success", attempts: 1, error: null });
	});

	it("节点失败：失败原因一行、异常信息（不含堆栈）和完整的错误信息（含堆栈）、日志尾部都在，后面的节点被跳过", async () => {
		const runId = await start(flow([echo("a"), echo("b"), echo("c")]));
		await agent.succeed(await agent.nextAssign());
		const task = await agent.nextAssign();
		agent.logs(task, [
			[1, "开始检查"],
			[2, "余额 0"],
		]);
		await logsWritten(task, 2);
		clock().advance(3_000);
		await agent.fail(task, `ValueError: 余额不足\n\n${STACK}`);

		const report = await summary(runId);
		expect(report).toMatchObject({
			status: "failed",
			result_so_far: "failed",
			failures: ["b"],
			failed_tasks_total: 1,
		});
		expect(node(report, "b")).toMatchObject({
			status: "failed",
			attempts: 1,
			error: {
				kind: "node_error",
				headline: "ValueError: 余额不足",
				message: "ValueError: 余额不足",
				message_truncated: false,
				location: null,
			},
		});
		expect(node(report, "c")).toMatchObject({ status: "skipped", attempts: 0, error: null });
		expect(report.failed_tasks).toHaveLength(1);
		const [failed] = report.failed_tasks;
		expect(failed).toMatchObject({
			chain_instance_id: report.chains[0]?.id,
			chain: null,
			node_id: "b",
			kind: "package",
			node_type: "stub/echo",
			attempt: 1,
			attempts: 1,
			task_id: task.taskId,
			error: {
				kind: "node_error",
				headline: "ValueError: 余额不足",
				detail: `ValueError: 余额不足\n\n${STACK}`,
			},
			logs: { earlier: false, expired: false },
		});
		expect(failed?.logs?.lines.map((l) => [l.seq, l.level, l.text])).toEqual([
			[1, "info", "开始检查"],
			[2, "info", "余额 0"],
		]);
	});

	it("重试之后成功的节点：失败的那几次也列在失败的任务里，运行结果是成功", async () => {
		const runId = await start(flow([echo("a", { retries: 2 }), echo("b")]));
		const first = await agent.nextAssign();
		await agent.fail(first, "第一次：网络抖动", ErrorKind.TIMEOUT);
		const second = await agent.nextAssign();
		await agent.fail(second, "第二次：网络抖动");
		await agent.succeed(await agent.nextAssign());
		await agent.succeed(await agent.nextAssign());

		const report = await summary(runId);
		expect(report).toMatchObject({ status: "success", failures: [], failed_tasks_total: 2 });
		expect(node(report, "a")).toMatchObject({ status: "success", attempts: 3, error: null });
		expect(
			report.failed_tasks.map((t) => [t.node_id, t.attempt, t.attempts, t.error?.kind]),
		).toEqual([
			["a", 1, 3, "timeout"],
			["a", 2, 3, "node_error"],
		]);
		expect(report.failed_tasks.map((t) => t.task_id)).toEqual([first.taskId, second.taskId]);
	});

	it("取消：请求取消后还没结束时 result_so_far 是 cancelled，结束后 status 也是 cancelled，取消的人和时间在 cancel 里", async () => {
		const runId = await start(flow([echo("a"), echo("b")]));
		const task = await agent.nextAssign();
		clock().advance(2_000);
		await api.cancelOk(runId);

		const cancelling = await summary(runId);
		expect(cancelling).toMatchObject({
			status: "running",
			result_so_far: "cancelled",
			ended_at: null,
			duration_ms: null,
			cancel: {
				requested_by: "tester",
				requested_via: null,
				requested_at: iso(T0 + 2_000),
				forced_at: null,
			},
		});

		await agent.nextCancel();
		await agent.cancelled(task);
		const report = await summary(runId);
		expect(report).toMatchObject({
			status: "cancelled",
			result_so_far: "cancelled",
			failures: [],
			failed_tasks: [],
			duration_ms: 2_000,
		});
		expect(node(report, "a")).toMatchObject({ status: "cancelled", error: null });
		expect(node(report, "b")).toMatchObject({ status: "cancelled", attempts: 0, error: null });
	});

	it("重试在排队时被取消：节点的状态和起止时间取同一行（没开始、结束是取消的时间），不是上一次尝试的时间", async () => {
		// 只有 1 个槽位的 Agent：第二个运行的任务先排在槽位后面，第一个运行的重试只能接着排队。
		const solo = await FakeAgent.connect(
			cp.grpcUrl,
			{ name: "agent-solo", slots: 1 },
			{ clock: cp.clock },
		);
		try {
			const onSolo = (nodes: Node[]) => ({ ...flow(nodes), default_agent: "agent-solo" });
			const first = await start(onSolo([echo("a", { retries: 1 })]));
			const attempt1 = await solo.nextAssign();
			const second = await start(onSolo([echo("a")]));
			await eventually(async () => expect((await api.node(second, "a")).status).toBe("queued"));
			await solo.fail(attempt1, "第一次失败");
			// 槽位给了先排队的第二个运行；第一个运行的重试排队。
			expect((await solo.nextAssign()).runId).toBe(second);
			await eventually(async () => expect((await api.node(first, "a")).status).toBe("queued"));
			clock().advance(4_000);
			await api.cancelOk(first);

			const report = await summary(first);
			expect(node(report, "a")).toMatchObject({
				status: "cancelled",
				attempts: 1,
				started_at: null,
				ended_at: iso(T0 + 4_000),
				error: null,
			});
			expect(report.failures).toEqual([]);
		} finally {
			await solo.disconnect();
		}
	});

	it("还在执行的运行：没有结束时间和耗时，没开始的节点是 pending，已经成功的节点有结果", async () => {
		const runId = await start(flow([echo("a"), echo("b"), echo("c")]));
		await agent.succeed(await agent.nextAssign());
		await agent.nextAssign();

		const report = await summary(runId);
		expect(report).toMatchObject({
			status: "running",
			result_so_far: "success",
			ended_at: null,
			duration_ms: null,
			failures: [],
			failed_tasks: [],
		});
		expect(node(report, "a")).toMatchObject({ status: "success", attempts: 1 });
		expect(node(report, "b")).toMatchObject({ status: "running", attempts: 1 });
		expect(node(report, "c")).toMatchObject({
			status: "pending",
			attempts: 0,
			started_at: null,
			ended_at: null,
			error: null,
		});
	});

	describe("日志读不到时的标记 missing", () => {
		it("运行没过保留期、日志文件却不在了：lines 为空、missing 为 true；任务没写过日志时 missing 为 false", async () => {
			const runId = await start(flow([echo("a"), echo("b", { always: true })]));
			const a = await agent.nextAssign();
			agent.logs(a, [
				[1, "开始"],
				[2, "出错前"],
			]);
			await logsWritten(a, 2);
			await agent.fail(a, "boom");
			const b = await agent.nextAssign();
			await agent.fail(b, "没写过日志就失败");
			const file = join(cp.dataDir, "logs", runId, `${a.taskId}.jsonl`);
			await rm(file);

			const report = await summary(runId);
			const tail = (nodeId: string) => report.failed_tasks.find((t) => t.node_id === nodeId)?.logs;
			expect(tail("a")).toEqual({ lines: [], earlier: false, expired: false, missing: true });
			expect(tail("b")).toEqual({ lines: [], earlier: false, expired: false, missing: false });
		});

		it("日志文件在时 missing 为 false", async () => {
			const runId = await start(flow([echo("a")]));
			const a = await agent.nextAssign();
			agent.logs(a, [[1, "有日志"]]);
			await logsWritten(a, 1);
			await agent.fail(a, "boom");
			expect((await summary(runId)).failed_tasks[0]?.logs).toMatchObject({
				expired: false,
				missing: false,
			});
		});
	});

	it("保密参数的值在错误信息、日志、失败的动作里都打码，原文一处也看不到", async () => {
		const runId = await start(flow([echo("a")]));
		const task = await agent.nextAssign();
		agent.logs(task, [[1, "登录 tk-secret"]]);
		await logsWritten(task, 1);
		const stamp = agent.stamp(T0 + 500);
		agent.actionSummary(task, {
			total: 1,
			reported: 1,
			recent_failed: [
				{
					id: 1,
					parent: null,
					depth: 0,
					name: "登录 tk-secret",
					fields: { 口令: "tk-secret" },
					...stamp,
					end_ts: T0 + 900,
					end_mono: agent.stamp(T0 + 900).mono,
					result: "failed",
					reason: "认证失败：tk-secret",
				},
			],
		});
		await eventually(async () => {
			const res = await cp.fetch(`/tasks/${task.taskId}/actions/summary`);
			expect(((await res.json()) as { total: number }).total).toBe(1);
		});
		await agent.fail(task, `PermissionError: tk-secret 无效\n\n${STACK}\nraise tk-secret`);

		const res = await summaryRes(runId);
		const body = await res.text();
		expect(res.status).toBe(200);
		expect(body).not.toContain("tk-secret");
		const report = runSummaryApi.summary.response.parse(JSON.parse(body));
		expect(report.failed_tasks[0]?.error?.headline).toBe("PermissionError: ****** 无效");
		expect(report.failed_tasks[0]?.error?.detail).toContain("raise ******");
		expect(report.failed_tasks[0]?.logs?.lines.map((l) => l.text)).toEqual(["登录 ******"]);
		expect(report.failed_actions).toHaveLength(1);
		expect(report.failed_actions[0]).toMatchObject({
			name: "登录 ******",
			fields: { 口令: "******" },
			reason: "认证失败：******",
		});
	});

	describe("摘要里来自日志的内容读取时再打码", () => {
		const LATER = "later-pw-3f9d2a71";

		/** 主链 entry → spawn0 → gate → spawn1；子流程「前」里有 x，子流程「后」声明保密参数 pw（值由 spawn1 传入）。 */
		const document = (x: Node) => {
			const doc = orchestration(
				[
					[
						{ id: "entry", kind: "entry", params: [] },
						spawn("spawn0"),
						chainEcho("gate"),
						spawn("spawn1", { pw: LATER }),
					],
					[{ id: "sub0", kind: "subflow_entry", name: "前", params: [] }, x],
					[
						{
							id: "sub1",
							kind: "subflow_entry",
							name: "后",
							params: [{ name: "pw", type: "string", secret: true }],
						},
						chainEcho("y"),
					],
				],
				[
					["spawn0", "sub0"],
					["spawn1", "sub1"],
				],
			);
			return { ...doc, packages: { ...doc.packages, bench: "1.0.0" } };
		};
		/** 让保密参数的子流程创建出来：gate 成功，spawn1 触发子流程「后」。 */
		const createLaterSubflow = async (runId: string, gate: AssignedTask) => {
			await agent.succeed(gate);
			await eventually(async () => expect((await api.run(runId)).chains).toHaveLength(3));
		};
		const assignsOf = async (n: number) => {
			const found: Record<string, AssignedTask> = {};
			for (let i = 0; i < n; i++) {
				const task = await agent.nextAssign();
				found[task.nodeId] = task;
			}
			return found;
		};

		it("失败的任务的日志尾部：子流程创建之前写下的行，摘要里也是掩码", async () => {
			const runId = await start(document(chainEcho("x")));
			const { x, gate } = await assignsOf(2);
			agent.logs(x as AssignedTask, [[1, `连接口令 ${LATER}`]]);
			await logsWritten(x as AssignedTask, 1);
			await agent.fail(x as AssignedTask, "boom");
			await createLaterSubflow(runId, gate as AssignedTask);

			const res = await summaryRes(runId);
			const body = await res.text();
			expect(res.status).toBe(200);
			expect(body).not.toContain(LATER);
			const report = runSummaryApi.summary.response.parse(JSON.parse(body));
			expect(report.failed_tasks.map((t) => t.node_id)).toEqual(["x"]);
			expect(report.failed_tasks[0]?.logs?.lines.map((l) => l.text)).toEqual(["连接口令 ******"]);
		});

		it("重试之后成功的节点：失败的那次尝试的日志尾部，摘要里也是掩码", async () => {
			const runId = await start(document({ ...chainEcho("x"), retries: 1 }));
			const { x, gate } = await assignsOf(2);
			agent.logs(x as AssignedTask, [[1, `连接口令 ${LATER}`]]);
			await logsWritten(x as AssignedTask, 1);
			await agent.fail(x as AssignedTask, "第一次失败");
			const retry = await agent.nextAssign();
			expect(retry).toMatchObject({ nodeId: "x", attempt: 2 });
			await agent.succeed(retry, { text: LATER });
			await createLaterSubflow(runId, gate as AssignedTask);

			const body = await (await summaryRes(runId)).text();
			expect(body).not.toContain(LATER);
			const report = runSummaryApi.summary.response.parse(JSON.parse(body));
			expect(report.failed_tasks.map((t) => [t.node_id, t.attempt])).toEqual([["x", 1]]);
			expect(report.failed_tasks[0]?.logs?.lines.map((l) => l.text)).toEqual(["连接口令 ******"]);
		});

		it("有异常的关注项：日志类异常的说明（最近一条 WARN / ERROR 的正文），摘要里也是掩码", async () => {
			const bench: Node = {
				id: "x",
				kind: "package",
				package: "bench",
				node: "probe",
				inputs: {},
			};
			const id = await api.orchestrationWith(document(bench));
			await putFocusItemsOk(api, id, [{ node_id: "x", chart: "level" }]);
			const runId = await api.triggerOk(id);
			const { x, gate } = await assignsOf(2);
			agent.logs(x as AssignedTask, [
				{
					seq: 1n,
					timeUnixMs: BigInt(T0),
					source: LogSource.STDOUT,
					level: LogLevel.ERROR,
					text: `认证失败：${LATER}`,
				},
			]);
			await agent.sync();
			await createLaterSubflow(runId, gate as AssignedTask);

			const body = await (await summaryRes(runId)).text();
			expect(body).not.toContain(LATER);
			const report = runSummaryApi.summary.response.parse(JSON.parse(body));
			expect(report.attention_items).toHaveLength(1);
			expect(report.attention_items[0]?.anomaly).toMatchObject({
				kind: "log",
				level: "error",
				message: "认证失败：******",
			});
		});
	});

	it("失败的动作：每个任务最近失败的那几个，最近结束的在前，带上所在的节点和尝试", async () => {
		const runId = await start(flow([echo("a", { retries: 1 })]));
		const failedAction = (id: number, name: string, endedAt: number) => ({
			id,
			parent: null,
			depth: 0,
			name,
			fields: { 订单: String(id) },
			...agent.stamp(endedAt - 100),
			end_ts: endedAt,
			end_mono: agent.stamp(endedAt).mono,
			result: "failed" as const,
			reason: `原因 ${id}`,
		});
		const first = await agent.nextAssign();
		agent.actionSummary(first, {
			total: 2,
			reported: 2,
			recent_failed: [failedAction(2, "下单", T0 + 3_000), failedAction(1, "下单", T0 + 1_000)],
		});
		await agent.fail(first, "第一次失败");
		const second = await agent.nextAssign();
		agent.actionSummary(second, {
			total: 1,
			reported: 1,
			recent_failed: [failedAction(1, "付款", T0 + 2_000)],
		});
		await eventually(async () => {
			const res = await cp.fetch(`/tasks/${second.taskId}/actions/summary`);
			expect(((await res.json()) as { total: number }).total).toBe(1);
		});
		await agent.fail(second, "第二次失败");

		const report = await summary(runId);
		expect(report.failed_actions.map((a) => [a.name, a.attempt, a.reason, a.task_id])).toEqual([
			["下单", 1, "原因 2", first.taskId],
			["付款", 2, "原因 1", second.taskId],
			["下单", 1, "原因 1", first.taskId],
		]);
		expect(report.failed_actions[0]).toMatchObject({
			chain_instance_id: report.chains[0]?.id,
			node_id: "a",
			display_name: null,
			fields: { 订单: "2" },
			result: "failed",
			duration_ms: 100,
			ended_at: iso(T0 + 3_000),
		});
	});

	describe("有异常的关注项", () => {
		const benchRun = async (focus: Array<{ node_id: string; chart: string }> = []) => {
			const id = await api.orchestrationWith(benchDocument());
			if (focus.length > 0) await putFocusItemsOk(api, id, focus);
			return api.triggerOk(id);
		};

		it("场景设了关注项时，只列有异常的：失败的节点的那一项带异常的原因和最新值", async () => {
			const runId = await benchRun([
				{ node_id: "load", chart: "TPS" },
				{ node_id: "probe", chart: "level" },
			]);
			const load = await agent.nextAssign();
			agent.metrics(load, [["tps", T0 / 1000 + 1, 500]]);
			await agent.sync();
			clock().advance(2_000);
			await agent.fail(load, "RuntimeError: 压测机掉线\n\n" + STACK);

			const report = await summary(runId);
			expect(report.attention_items).toHaveLength(1);
			expect(report.attention_items[0]).toMatchObject({
				position: 1,
				node_id: "load",
				chart: "TPS",
				title: "TPS",
				unit: "req/s",
				source: { status: "failed" },
				latest: { value: 500 },
				anomaly: { kind: "failed", message: "RuntimeError: 压测机掉线" },
			});
		});

		it("没有异常时一项也不列；场景没设关注项时不用主指标代替，也不列", async () => {
			const withItems = await benchRun([{ node_id: "load", chart: "TPS" }]);
			await agent.nextAssign();
			expect((await summary(withItems)).attention_items).toEqual([]);

			const without = await benchRun();
			const task = await agent.nextAssign();
			await agent.fail(task, "boom");
			const report = await summary(without);
			expect(report.status).toBe("failed");
			expect(report.attention_items).toEqual([]);
		});
	});

	describe("数量上限", () => {
		it("日志尾部最多 50 行（最后的 50 行），前面还有更早的日志时 earlier 为 true", async () => {
			const runId = await start(flow([echo("a")]));
			const task = await agent.nextAssign();
			for (let from = 1; from <= 120; from += 40) {
				agent.logs(
					task,
					Array.from({ length: 40 }, (_, i): [number, string] => [from + i, `第 ${from + i} 行`]),
				);
			}
			await logsWritten(task, 120);
			await agent.fail(task, "boom");

			const logs = (await summary(runId)).failed_tasks[0]?.logs;
			expect(logs?.lines).toHaveLength(50);
			expect(logs?.lines[0]?.seq).toBe(71);
			expect(logs?.lines.at(-1)?.seq).toBe(120);
			expect(logs).toMatchObject({ earlier: true, expired: false });
		});

		it("失败的任务最多列 20 个（先失败的在前），总数在 failed_tasks_total，只有列出来的带日志", async () => {
			const runId = await start(flow([echo("a", { retries: 24 })]));
			for (let attempt = 1; attempt <= 25; attempt++) {
				const task = await agent.nextAssign();
				expect(task.attempt).toBe(attempt);
				await agent.fail(task, `第 ${attempt} 次失败`);
			}

			const report = await summary(runId);
			expect(report.failed_tasks_total).toBe(25);
			expect(report.failed_tasks).toHaveLength(20);
			expect(report.failed_tasks.map((t) => t.attempt)).toEqual(
				Array.from({ length: 20 }, (_, i) => i + 1),
			);
			expect(report.failed_tasks.every((t) => t.logs !== null)).toBe(true);
			expect(report.chains[0]?.nodes.find((n) => n.node_id === "a")).toMatchObject({
				attempts: 25,
				error: { message: "第 25 次失败" },
			});
		});
	});

	it("历史运行里已移除种类的节点（ADR 0028）：种类名是它当时的，不报错", async () => {
		await seedRemovedKindScenario(cp);

		const report = await summary(IDS.run);
		expect(report.status).toBe("success");
		expect(
			report.chains[0]?.nodes.map((n) => [n.node_id, n.kind, n.display_name, n.status]),
		).toEqual([
			["entry", "entry", null, "success"],
			["wait", "sleep", "歇一会", "success"],
			["at", "timer", null, "success"],
			["notify", "feishu_notify", "通知群", "success"],
		]);
	});

	it("运行不存在时 404；运行编号写成大写时照样查得到", async () => {
		const none = await summaryRes("00000000-0000-0000-0000-000000000000");
		expect(none.status).toBe(404);
		expect(((await none.json()) as { error: { code: string } }).error.code).toBe("not_found");
		expect((await summaryRes("not-a-uuid")).status).toBe(404);

		const runId = await start(flow([echo("a")]));
		await agent.fail(await agent.nextAssign(), "boom");
		const upper = await summary(runId.toUpperCase());
		expect(upper.run_id).toBe(runId);
		expect(upper.failed_tasks).toHaveLength(1);
	});
});
