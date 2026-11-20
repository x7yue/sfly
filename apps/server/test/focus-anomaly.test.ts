// 切入点 A：关注项的异常和「异常在前」的排序（#351），以及任务日志里 WARN / ERROR 的统计。真实控制面 + 讲真实 gRPC 的
// 假 Agent + 手动时钟 + 独立的 PostgreSQL，通过 HTTP 接口 GET /runs/:id/focus 观察。时钟一次推进十几分钟：
// 任务租约设得很长，没有心跳的假 Agent 的任务不会以 agent_lost 结束。
import { type RunFocus, type RunFocusItem, runFocusApi } from "@sfly/schema";
import { afterEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { type AssignedTask, FakeAgent, LogLevel, LogSource } from "./support/fake-agent.js";
import {
	benchDocument,
	type FocusItemBody,
	publishBench,
	putFocusItemsOk,
} from "./support/focus-items.js";
import type { ManualClock } from "./support/manual-clock.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const T0 = Date.UTC(2026, 0, 1);
const DAY = 24 * 60 * 60 * 1000;
const MIN = 60_000;
/** 起点之后第 s 秒（Unix 秒），指标点用它。 */
const at = (s: number) => T0 / 1000 + s;
/** 起点之后第 ms 毫秒（ISO）。 */
const iso = (ms: number) => new Date(T0 + ms).toISOString();

/** 入口 → 停止子流程 mon 的节点在 load 之后；mon 里是 watch。 */
const STOP_DOCUMENT = {
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry" },
		{ id: "spawn", kind: "async", params: {} },
		{ id: "load", kind: "package", package: "bench", node: "load" },
		{ id: "stop", kind: "stop_subflow", subflow: "mon" },
		{ id: "mon", kind: "subflow_entry", params: [] },
		{ id: "watch", kind: "package", package: "bench", node: "probe" },
	],
	edges: [
		{ from: "entry", to: "spawn", kind: "chain" },
		{ from: "spawn", to: "load", kind: "chain" },
		{ from: "load", to: "stop", kind: "chain" },
		{ from: "mon", to: "watch", kind: "chain" },
		{ from: "spawn", to: "mon", kind: "dispatch" },
	],
	packages: { bench: "1.0.0" },
};

describe("关注项的异常", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let agent: FakeAgent;
	const clock = () => cp.clock as ManualClock;
	/** 把手动时钟拨到起点之后第 ms 毫秒。 */
	const setClock = (ms: number) => clock().set(new Date(T0 + ms));

	const start = async (options: { logLimitBytes?: number } = {}) => {
		cp = await startTestControlPlane({ leaseMs: 400 * DAY, ...options });
		api = new ApiClient(cp);
		await publishBench(cp);
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 4 }, { clock: cp.clock });
	};
	afterEach(async () => {
		await agent.disconnect();
		await cp.close();
	});

	/** 建场景（默认 entry → load → probe）、设关注项、触发运行。 */
	const trigger = async (items: FocusItemBody[], document: object = benchDocument()) => {
		const id = await api.orchestrationWith(document);
		await putFocusItemsOk(api, id, items);
		return api.triggerOk(id);
	};
	const focus = async (runId: string): Promise<RunFocus> => {
		const res = await cp.fetch(`/runs/${runId}/focus`);
		expect(res.status, await res.clone().text()).toBe(200);
		return runFocusApi.focus.response.parse(await res.json());
	};
	const item = async (runId: string): Promise<RunFocusItem> => {
		const [first] = (await focus(runId)).items;
		if (!first) throw new Error("no focus item");
		return first;
	};
	const anomaly = async (runId: string) => (await item(runId)).anomaly;
	/** 一行日志：控制面时间是收到它的时刻（手动时钟的当前时刻）。 */
	const log = async (task: AssignedTask, seq: number, level: LogLevel, text: string) => {
		agent.logs(task, [
			{ seq: BigInt(seq), timeUnixMs: BigInt(T0), source: LogSource.STDOUT, level, text },
		]);
		await agent.sync();
	};
	/** p99 在这几秒（相对起点）上报的点。 */
	const p99 = async (task: AssignedTask, seconds: number[]) => {
		agent.metrics(
			task,
			seconds.map((s): [string, number, number] => ["p99", at(s), s]),
		);
		await agent.sync();
	};
	const range = (from: number, to: number, step: number) =>
		Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);

	it("log：最近一条 WARN / ERROR 在 10 分钟以内算异常，写明级别、时间、正文和这次尝试的总条数，满 10 分钟后撤下", async () => {
		await start();
		const runId = await trigger([{ node_id: "load", chart: "延迟" }]);
		const task = await agent.nextAssign();
		await p99(task, [0]);
		expect(await anomaly(runId)).toBeNull();

		setClock(5000);
		await log(task, 1, LogLevel.WARN, "下单接口 p99 超过 20ms：23.4ms");
		expect(await anomaly(runId)).toEqual({
			kind: "log",
			level: "warn",
			at: iso(5000),
			message: "下单接口 p99 超过 20ms：23.4ms",
			count: 1,
		});

		// INFO 不算；ERROR 换成最近一条，总条数是 WARN 和 ERROR 合计。
		setClock(65_250);
		await log(task, 2, LogLevel.INFO, "批次已提交");
		await log(task, 3, LogLevel.ERROR, "连接被重置（connection reset by peer）");
		await p99(task, [65]);
		const error = {
			kind: "log",
			level: "error",
			at: iso(65_250),
			message: "连接被重置（connection reset by peer）",
			count: 2,
		};
		expect(await anomaly(runId)).toEqual(error);

		// 正好 10 分钟仍算，再过 1 毫秒撤下（点一直在更新，没有别的异常）。
		setClock(65_250 + 10 * MIN);
		await p99(task, [665]);
		expect(await anomaly(runId)).toEqual(error);
		setClock(65_250 + 10 * MIN + 1);
		expect(await anomaly(runId)).toBeNull();
	});

	it("WARN / ERROR 的统计在写日志时更新、存进库里（控制面重启后照旧）；正文截到 500 个字符；日志截断以后不再增加", async () => {
		await start({ logLimitBytes: 4096 });
		const runId = await trigger([{ node_id: "load", chart: "延迟" }]);
		const task = await agent.nextAssign();

		await log(task, 1, LogLevel.WARN, "警".repeat(600));
		expect(await anomaly(runId)).toMatchObject({ level: "warn", count: 1 });
		expect((await anomaly(runId))?.message).toBe("警".repeat(500));

		setClock(1000);
		await log(task, 2, LogLevel.ERROR, "连接被重置");
		expect(await anomaly(runId)).toMatchObject({ level: "error", at: iso(1000), count: 2 });

		// 放不下的一行换成截断标记（一行 WARN，计入）；之后的行不再写入，也不再计数。
		setClock(2000);
		await log(task, 3, LogLevel.INFO, "x".repeat(4096));
		const truncated = {
			kind: "log",
			level: "warn",
			at: iso(2000),
			message: "日志超过 4 KB 上限，之后的内容已被截断",
			count: 3,
		};
		expect(await anomaly(runId)).toEqual(truncated);
		setClock(3000);
		await log(task, 4, LogLevel.ERROR, "截断之后的 ERROR");
		await log(task, 5, LogLevel.WARN, "截断之后的 WARN");
		expect(await anomaly(runId)).toEqual(truncated);

		// 重启后只读：Agent 不重连（重连时不上报这个任务的话，任务会以失联结束）。
		await agent.disconnect();
		await cp.restart();
		expect(await anomaly(runId)).toEqual(truncated);
	});

	it("stale：执行中的节点距离最后一个点超过 6 倍采样间隔才算；采样间隔是间隔的中位数，有新点后撤下", async () => {
		await start();
		const runId = await trigger([{ node_id: "load", chart: "延迟" }]);
		const task = await agent.nextAssign();
		await p99(task, range(0, 90, 10));
		expect(await item(runId)).toMatchObject({
			last_at: iso(90_000),
			sample_interval_ms: 10_000,
			anomaly: null,
		});

		setClock(150_000);
		expect(await anomaly(runId)).toBeNull();
		setClock(150_001);
		expect(await anomaly(runId)).toEqual({ kind: "stale", at: iso(90_000), message: "" });

		await p99(task, [150]);
		expect(await anomaly(runId)).toBeNull();
	});

	it("没有新数据另给 stale_since，和报哪一种异常无关：先打 WARN 再不上报时异常是 log，stale_since 照样是最后一个点的时间", async () => {
		await start();
		const runId = await trigger([{ node_id: "load", chart: "延迟" }]);
		const task = await agent.nextAssign();
		await p99(task, range(0, 90, 10));
		setClock(100_000);
		await log(task, 1, LogLevel.WARN, "慢");
		expect(await item(runId)).toMatchObject({ anomaly: { kind: "log" }, stale_since: null });

		setClock(150_001);
		expect(await item(runId)).toMatchObject({
			anomaly: { kind: "log" },
			last_at: iso(90_000),
			stale_since: iso(90_000),
		});

		await p99(task, [150]);
		expect(await item(runId)).toMatchObject({ anomaly: { kind: "log" }, stale_since: null });
	});

	it("stale_since：一个点都没有时从开始执行算起；准备中、已结束时为 null", async () => {
		await start();
		const runId = await trigger([{ node_id: "load", chart: "延迟" }]);
		const task = await agent.nextAssign({ start: false });
		setClock(10 * MIN);
		expect((await item(runId)).stale_since).toBeNull();

		await agent.started(task);
		setClock(10 * MIN + 30_001);
		expect((await item(runId)).stale_since).toBe(iso(10 * MIN));

		await agent.succeed(task);
		expect((await item(runId)).stale_since).toBeNull();
	});

	it("stale：6 倍采样间隔不到 30 秒时按 30 秒判断；点不够两个时没有采样间隔，也按 30 秒", async () => {
		await start();
		const runId = await trigger([
			{ node_id: "load", chart: "延迟" },
			{ node_id: "load", chart: "TPS" },
		]);
		const task = await agent.nextAssign();
		await p99(task, range(0, 18, 2));
		agent.metrics(task, [["tps", at(3), 500]]);
		await agent.sync();
		let [latency, tps] = (await focus(runId)).items;
		expect(latency?.sample_interval_ms).toBe(2000);
		expect(tps).toMatchObject({ last_at: iso(3000), sample_interval_ms: null });

		setClock(33_000);
		[latency, tps] = (await focus(runId)).items;
		expect([latency?.anomaly, tps?.anomaly]).toEqual([null, null]);
		setClock(33_001);
		[tps, latency] = (await focus(runId)).items;
		expect(tps).toMatchObject({ chart: "TPS", anomaly: { kind: "stale", at: iso(3000) } });
		expect(latency?.anomaly).toBeNull();

		setClock(48_000);
		expect((await focus(runId)).items.map((i) => [i.chart, i.anomaly?.kind ?? null])).toEqual([
			["TPS", "stale"],
			["延迟", null],
		]);
		setClock(48_001);
		expect((await focus(runId)).items.map((i) => [i.chart, i.anomaly?.kind ?? null])).toEqual([
			["延迟", "stale"],
			["TPS", "stale"],
		]);
	});

	it("stale：一个点都没有时从开始执行算起；还在准备中（没开始执行）的节点不判断", async () => {
		await start();
		const runId = await trigger([{ node_id: "load", chart: "延迟" }]);
		const task = await agent.nextAssign({ start: false });
		setClock(10 * MIN);
		expect(await item(runId)).toMatchObject({
			source: { status: "dispatched", started_at: null },
			anomaly: null,
		});

		await agent.started(task);
		setClock(10 * MIN + 30_000);
		expect(await anomaly(runId)).toBeNull();
		setClock(10 * MIN + 30_001);
		expect(await item(runId)).toMatchObject({
			last_at: null,
			sample_interval_ms: null,
			anomaly: { kind: "stale", at: iso(10 * MIN), message: "" },
		});
	});

	it("采样间隔只看最近 10 个点、取中位数（一个长间隔不影响）；这些点跨了两段，控制面重启后从库里读，结果一样", async () => {
		await start();
		const runId = await trigger([{ node_id: "load", chart: "延迟" }]);
		const task = await agent.nextAssign();
		// 先是 115 个点每 2 秒一个；最近 10 个点之间的 9 个间隔是 9、9、30、9、9、4、4、4、4 秒，中位数 9 秒。
		// 一段 120 个点：最近 10 个点的前 5 个在第一段，后 5 个在第二段（只看第二段是 4 秒，看全部点是 2 秒）。
		const recent = [237, 246, 255, 285, 294, 303, 307, 311, 315, 319];
		await p99(task, [...range(0, 228, 2), ...recent]);
		expect(await item(runId)).toMatchObject({ last_at: iso(319_000), sample_interval_ms: 9000 });

		await agent.disconnect();
		await cp.restart();
		expect(await item(runId)).toMatchObject({
			source: { status: "running" },
			last_at: iso(319_000),
			sample_interval_ms: 9000,
		});
	});

	it("采样快于 1 秒（同一秒里上报了几个点）：采样间隔按 1 秒算，不是 0", async () => {
		await start();
		const runId = await trigger([{ node_id: "load", chart: "延迟" }]);
		const task = await agent.nextAssign();
		// 单调时钟读数每 100 毫秒一个：控制面时间都落在第 5 秒，依次排到后面的秒上。
		agent.metrics(
			task,
			range(0, 9, 1).map((i) => ({
				name: "p99",
				timeUnixS: BigInt(at(5)),
				monotonicMs: agent.monotonicAt(at(5) * 1000 + i * 100),
				value: i,
				min: i,
				max: i,
			})),
		);
		await agent.sync();
		expect(await item(runId)).toMatchObject({ last_at: iso(14_000), sample_interval_ms: 1000 });
	});

	it("failed：来源节点失败就算，不限时间；写明失败的时间和错误信息的第一行，比最近的 WARN 优先", async () => {
		await start();
		const runId = await trigger([{ node_id: "load", chart: "延迟" }]);
		const task = await agent.nextAssign();
		setClock(4000);
		await log(task, 1, LogLevel.WARN, "快要超时了");
		setClock(5000);
		await agent.fail(
			task,
			'AssertionError: 漏拦 3 笔\n\nTraceback (most recent call last):\n  File "x.py"',
		);
		const failed = { kind: "failed", at: iso(5000), message: "AssertionError: 漏拦 3 笔" };
		expect(await anomaly(runId)).toEqual(failed);

		setClock(5000 + 60 * MIN);
		expect(await anomaly(runId)).toEqual(failed);
	});

	it("failed：原因去掉异常的模块路径，第一行以冒号结尾时接上下一行（断言失败的第 1 条）", async () => {
		await start();
		const runId = await trigger([{ node_id: "load", chart: "延迟" }]);
		const task = await agent.nextAssign();
		setClock(5000);
		await agent.fail(
			task,
			"sfly_std.assert_.AssertionFailed: 1 条断言中 1 条不通过：\n第 1 条：$ 应 eq true，实际是 false\n\nTraceback (most recent call last):",
		);
		expect(await anomaly(runId)).toEqual({
			kind: "failed",
			at: iso(5000),
			message: "AssertionFailed: 1 条断言中 1 条不通过：第 1 条：$ 应 eq true，实际是 false",
		});
	});

	it("retry：最新一次尝试的号大于 1、10 分钟以内开始的算异常，原因是上一次的错误；还没开始执行时按排队的时间", async () => {
		await start();
		const document = benchDocument();
		const runId = await trigger([{ node_id: "load", chart: "延迟" }], {
			...document,
			nodes: document.nodes.map((n) => (n.id === "load" ? { ...n, retries: 1 } : n)),
		});
		const first = await agent.nextAssign();
		await agent.fail(first, "ConnectionError: matcher 退出了\n  at main.py:12");

		setClock(1000);
		const second = await agent.nextAssign({ start: false });
		expect(await item(runId)).toMatchObject({
			source: { status: "dispatched", attempt: 2 },
			anomaly: { kind: "retry", at: iso(0), message: "ConnectionError: matcher 退出了" },
		});
		setClock(2000);
		await agent.started(second);
		await p99(second, [2]);
		const retry = { kind: "retry", at: iso(2000), message: "ConnectionError: matcher 退出了" };
		expect(await anomaly(runId)).toEqual(retry);

		setClock(2000 + 10 * MIN);
		await p99(second, [602]);
		expect(await anomaly(runId)).toEqual(retry);
		setClock(2000 + 10 * MIN + 1);
		expect(await anomaly(runId)).toBeNull();
	});

	it("这次运行的节点包版本里没有这张图表的项不判断无新数据（没有数据可等），节点上的 WARN、失败照常算", async () => {
		await start();
		// 运行锁定 bench 1.0.0（图表叫 TPS）；之后的版本里叫「吞吐」，作者按新名字设了关注项。
		const id = await api.orchestrationWith(benchDocument());
		const runId = await api.triggerOk(id);
		const task = await agent.nextAssign();
		await api.saveVersion(id, benchDocument(undefined, "2.0.0"));
		await putFocusItemsOk(api, id, [
			{ node_id: "load", chart: "吞吐" },
			{ node_id: "load", chart: "延迟" },
		]);
		const kinds = async () =>
			(await focus(runId)).items.map((i) => [
				i.chart,
				i.unavailable ?? null,
				i.anomaly?.kind ?? null,
			]);

		setClock(40_000);
		expect(await kinds()).toEqual([
			["延迟", null, "stale"],
			["吞吐", "chart_missing", null],
		]);
		expect((await focus(runId)).items.map((i) => i.stale_since)).toEqual([iso(0), null]);
		await log(task, 1, LogLevel.WARN, "慢");
		expect(await kinds()).toEqual([
			["吞吐", "chart_missing", "log"],
			["延迟", null, "log"],
		]);
	});

	it("同时满足几种时只报一种：failed、log、retry、stale 依次优先", async () => {
		await start();
		const document = benchDocument();
		const runId = await trigger([{ node_id: "load", chart: "延迟" }], {
			...document,
			nodes: document.nodes.map((n) => (n.id === "load" ? { ...n, retries: 1 } : n)),
		});
		await agent.fail(await agent.nextAssign(), "boom");
		const second = await agent.nextAssign();

		// 重试是 10 分钟以内开始的，也 40 秒没有点了：报重试。
		setClock(40_000);
		expect((await anomaly(runId))?.kind).toBe("retry");
		// 再来一条 WARN：报 WARN。
		await log(second, 1, LogLevel.WARN, "慢");
		expect((await anomaly(runId))?.kind).toBe("log");
		// WARN 和重试都过了 10 分钟，只剩无新数据。
		setClock(40_000 + 10 * MIN + 1);
		expect((await anomaly(runId))?.kind).toBe("stale");
		// 又有 WARN，然后失败：报失败。
		await log(second, 2, LogLevel.ERROR, "撑不住了");
		expect((await anomaly(runId))?.kind).toBe("log");
		await agent.fail(second, "boom again");
		expect((await anomaly(runId))?.kind).toBe("failed");
	});

	it("排序：有异常的项排在最前，其余按作者的顺序；异常撤下后回到原来的位置", async () => {
		await start();
		const runId = await trigger([
			{ node_id: "probe", chart: "level" },
			{ node_id: "load", chart: "延迟" },
			{ node_id: "load", chart: "TPS" },
		]);
		const task = await agent.nextAssign();
		await p99(task, [0]);
		const order = async () =>
			(await focus(runId)).items.map((i) => [i.position, i.chart, i.anomaly?.kind ?? null]);
		expect(await order()).toEqual([
			[1, "level", null],
			[2, "延迟", null],
			[3, "TPS", null],
		]);

		setClock(1000);
		await log(task, 1, LogLevel.WARN, "慢");
		expect(await order()).toEqual([
			[2, "延迟", "log"],
			[3, "TPS", "log"],
			[1, "level", null],
		]);

		setClock(1000 + 10 * MIN + 1);
		agent.metrics(task, [
			["p99", at(601), 1],
			["tps", at(601), 1],
		]);
		await agent.sync();
		expect(await order()).toEqual([
			[1, "level", null],
			[2, "延迟", null],
			[3, "TPS", null],
		]);
	});

	it("来源节点被取消后也是收尾：10 分钟内有 WARN、也有重试，仍不判断异常，final 为 true", async () => {
		await start();
		const document = benchDocument();
		const runId = await trigger([{ node_id: "load", chart: "延迟" }], {
			...document,
			nodes: document.nodes.map((n) => (n.id === "load" ? { ...n, retries: 1 } : n)),
		});
		const first = await agent.nextAssign();
		await agent.fail(first, "ConnectionError: matcher 退出了");
		const second = await agent.nextAssign();
		await p99(second, [0]);
		setClock(5000);
		await log(second, 1, LogLevel.WARN, "慢");
		expect(await item(runId)).toMatchObject({
			source: { status: "running", attempt: 2 },
			final: false,
			anomaly: { kind: "log" },
		});

		await api.cancelOk(runId);
		await agent.nextCancel();
		await agent.cancelled(second);
		setClock(10_000);
		expect(await item(runId)).toMatchObject({
			source: { status: "cancelled", attempt: 2 },
			final: true,
			anomaly: null,
		});
	});

	it("来源节点成功、已停止或已取消后只显示最终值，不判断异常：最近的 WARN、很久没有新点都不算", async () => {
		await start();
		const runId = await trigger(
			[
				{ node_id: "load", chart: "延迟" },
				{ node_id: "watch", chart: "level" },
			],
			STOP_DOCUMENT,
		);
		const tasks: Record<string, AssignedTask> = {};
		for (let i = 0; i < 2; i++) {
			const task = await agent.nextAssign();
			tasks[task.nodeId] = task;
		}
		await p99(tasks.load as AssignedTask, [0]);
		setClock(40_000);
		await log(tasks.load as AssignedTask, 1, LogLevel.WARN, "慢");
		await log(tasks.watch as AssignedTask, 1, LogLevel.ERROR, "探测失败");
		expect((await focus(runId)).items.map((i) => [i.node_id, i.anomaly?.kind])).toEqual([
			["load", "log"],
			["watch", "log"],
		]);

		// load 成功后停止子流程节点停止 mon：watch 被取消后记为已停止。
		await agent.succeed(tasks.load as AssignedTask);
		await agent.nextCancel();
		await agent.cancelled(tasks.watch as AssignedTask);
		expect(
			(await focus(runId)).items.map((i) => [i.node_id, i.source.status, i.final, i.anomaly]),
		).toEqual([
			["load", "success", true, null],
			["watch", "stopped", true, null],
		]);
	});
});
