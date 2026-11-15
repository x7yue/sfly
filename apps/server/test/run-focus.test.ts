// 切入点 A：一次运行的关注项读数 GET /runs/:id/focus（#350）。真实控制面 + 讲真实 gRPC 的假 Agent + 手动时钟
// + 独立的 PostgreSQL，通过 HTTP 接口观察。异常判断（`anomaly`）归「异常排最前」那张工单，这里只验证它总是 null。
import { type RunFocus, runFocusApi } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { type AssignedTask, FakeAgent } from "./support/fake-agent.js";
import { benchDocument, publishBench, putFocusItemsOk } from "./support/focus-items.js";
import type { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

/** 测试时钟的起点（2026-01-01T00:00:00Z）之后第 s 秒（Unix 秒）。 */
const at = (s: number) => Date.UTC(2026, 0, 1) / 1000 + s;
const iso = (s: number) => new Date(at(s) * 1000).toISOString();
const DAY = 24 * 60 * 60 * 1000;

/** 带标签的指标（按进程的 CPU）：折线 CPU 有几个序列；数值卡「合计」引用两个指标，只画第一个。 */
const PROCS = {
	watch: {
		outputs: [],
		metrics: [
			{ name: "cpu", unit: "%", kind: "gauge" as const, labels: ["pid"] },
			{ name: "mem", unit: "MB", kind: "gauge" as const },
			{ name: "total", unit: "单", kind: "counter" as const },
		],
		charts: [
			{ title: "CPU", type: "line" as const, metrics: ["cpu"] },
			{ title: "合计", type: "stat" as const, metrics: ["mem", "total"] },
		],
	},
};

/** 声明了主指标的节点：没设关注项时概览显示它。 */
const PRIM = {
	work: {
		outputs: [],
		metrics: [
			{ name: "done", unit: "单", kind: "counter" as const },
			{ name: "rate", unit: "单/s", kind: "gauge" as const },
		],
		primary_metric: "done",
	},
};

const point = (name: string, s: number, value: number, labels: Record<string, string> = {}) => ({
	name,
	labels,
	timeUnixS: BigInt(at(s)),
	value,
	min: value,
	max: value,
});

describe("运行的关注项读数", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let agent: FakeAgent;
	const clock = () => cp.clock as ManualClock;

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishBench(cp);
		await publishPackage(cp, "procs", "1.0.0", PROCS);
		await publishPackage(cp, "prim", "1.0.0", PRIM);
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 4 }, { clock: cp.clock });
	});
	afterEach(async () => {
		await agent.disconnect();
		await cp.close();
	});

	const focusRes = (runId: string, query = "") => cp.fetch(`/runs/${runId}/focus${query}`);
	const focus = async (runId: string, query = ""): Promise<RunFocus> => {
		const res = await focusRes(runId, query);
		expect(res.status, await res.clone().text()).toBe(200);
		return runFocusApi.focus.response.parse(await res.json());
	};
	/** 主链实例的 ID。 */
	const mainChain = async (runId: string) => (await api.run(runId)).chains[0]?.id as string;
	const withNodes = (
		document: ReturnType<typeof benchDocument>,
		extra: Record<string, Record<string, unknown>>,
	) => ({
		...document,
		nodes: document.nodes.map((n) => ({ ...n, ...extra[n.id] })),
	});

	it("按作者的顺序返回：位置从 1 开始，名字是作者起的或图表标题，带来源、单位、最新值和降采样序列；还没开始的节点没有数据", async () => {
		const id = await api.orchestrationWith(benchDocument());
		await putFocusItemsOk(api, id, [
			{ node_id: "load", chart: "延迟", title: "下单延迟" },
			{ node_id: "load", chart: "TPS" },
			{ node_id: "probe", chart: "level" },
		]);
		const runId = await api.triggerOk(id);
		const task = await agent.nextAssign();
		agent.metrics(task, [
			["p99", at(1), 10],
			["p99", at(2), 20],
			["p99", at(3), 30],
			["tps", at(3), 500],
		]);
		await agent.sync();
		clock().advance(10_000);

		const result = await focus(runId);
		expect(result).toMatchObject({ generated_at: iso(10), mode: "focus", expired: false });
		const [latency, tps, level] = result.items;
		expect(result.items.map((i) => [i.position, i.node_id, i.chart, i.title])).toEqual([
			[1, "load", "延迟", "下单延迟"],
			[2, "load", "TPS", "TPS"],
			[3, "probe", "level", "level"],
		]);
		expect(latency).toMatchObject({
			chart_type: "line",
			unit: "ms",
			source: {
				status: "running",
				attempt: 1,
				task_id: task.taskId,
				chain_instance_id: await mainChain(runId),
				started_at: iso(0),
				ended_at: null,
			},
			latest: { value: 30, metric: "p99", labels: {}, at: iso(3) },
			last_at: iso(3),
			bucket_seconds: 1,
			final: false,
			anomaly: null,
		});
		expect(latency?.unavailable).toBeUndefined();
		expect(latency?.series).toEqual([
			{
				metric: "p99",
				labels: {},
				points: [
					{ time: iso(1), min: 10, max: 10, last: 10 },
					{ time: iso(2), min: 20, max: 20, last: 20 },
					{ time: iso(3), min: 30, max: 30, last: 30 },
				],
			},
		]);
		expect(tps).toMatchObject({ chart_type: "area", unit: "req/s", latest: { value: 500 } });
		expect(level).toMatchObject({
			chart_type: "line",
			source: { status: "pending", attempt: 0, task_id: null, started_at: null },
			latest: null,
			last_at: null,
			series: [],
			final: false,
			anomaly: null,
		});
	});

	it("来源节点成功后是最终值：累计值显示当前累计，平台不算速率", async () => {
		const id = await api.orchestrationWith(benchDocument());
		await putFocusItemsOk(api, id, [{ node_id: "load", chart: "orders" }]);
		const runId = await api.triggerOk(id);
		const task = await agent.nextAssign();
		agent.metrics(task, [
			["orders", at(1), 100],
			["orders", at(2), 250],
		]);
		await agent.sync();
		expect((await focus(runId)).items[0]).toMatchObject({
			chart_type: "stat",
			latest: { value: 250 },
			final: false,
		});

		await agent.succeed(task);
		const [item] = (await focus(runId)).items;
		expect(item).toMatchObject({
			source: { status: "success", ended_at: iso(0) },
			latest: { value: 250, at: iso(2) },
			final: true,
			anomaly: null,
		});
	});

	it("节点重试后取最新一次尝试的任务，序列从新尝试开始", async () => {
		const document = withNodes(benchDocument(), { load: { retries: 1 } });
		const id = await api.orchestrationWith(document);
		await putFocusItemsOk(api, id, [{ node_id: "load", chart: "延迟" }]);
		const runId = await api.triggerOk(id);
		const first = await agent.nextAssign();
		agent.metrics(first, [
			["p99", at(1), 100],
			["p99", at(2), 200],
		]);
		await agent.fail(first, "boom");
		const second = await agent.nextAssign();
		clock().advance(7000);
		agent.metrics(second, [["p99", at(7), 5]]);
		await agent.sync();

		const [item] = (await focus(runId)).items;
		expect(item?.source).toMatchObject({ status: "running", attempt: 2, task_id: second.taskId });
		expect(item?.latest).toMatchObject({ value: 5, at: iso(7) });
		expect(item?.series).toEqual([
			{ metric: "p99", labels: {}, points: [{ time: iso(7), min: 5, max: 5, last: 5 }] },
		]);
	});

	it("子流程里的节点：来源是子流程实例上的任务", async () => {
		const document = {
			default_agent: "agent-a",
			nodes: [
				{ id: "entry", kind: "entry" },
				{ id: "spawn", kind: "async", params: {} },
				{ id: "load", kind: "package", package: "bench", node: "load" },
				{ id: "sub", kind: "subflow_entry", params: [] },
				{ id: "watch", kind: "package", package: "bench", node: "probe" },
			],
			edges: [
				{ from: "entry", to: "spawn", kind: "chain" },
				{ from: "spawn", to: "load", kind: "chain" },
				{ from: "sub", to: "watch", kind: "chain" },
				{ from: "spawn", to: "sub", kind: "dispatch" },
			],
			packages: { bench: "1.0.0" },
		};
		const id = await api.orchestrationWith(document);
		await putFocusItemsOk(api, id, [
			{ node_id: "watch", chart: "level" },
			{ node_id: "load", chart: "延迟" },
		]);
		const runId = await api.triggerOk(id);
		const tasks: Record<string, AssignedTask> = {};
		for (let i = 0; i < 2; i++) {
			const task = await agent.nextAssign();
			tasks[task.nodeId] = task;
		}
		agent.metrics(tasks.watch as AssignedTask, [["level", at(1), 3]]);
		await agent.sync();

		const run = await api.run(runId);
		const sub = run.chains.find((c) => c.chain_id === "sub");
		expect(sub?.id).not.toBe(await mainChain(runId));
		const [watch, load] = (await focus(runId)).items;
		expect(watch).toMatchObject({
			node_id: "watch",
			source: {
				status: "running",
				attempt: 1,
				task_id: tasks.watch?.taskId,
				chain_instance_id: sub?.id,
			},
			latest: { value: 3, at: iso(1) },
		});
		expect(load?.source.chain_instance_id).toBe(await mainChain(runId));
	});

	it("节点还不在这次运行里（子流程没有触发）的项不返回", async () => {
		const document = {
			default_agent: "agent-a",
			nodes: [
				{ id: "entry", kind: "entry" },
				{ id: "load", kind: "package", package: "bench", node: "load" },
				{ id: "spawn", kind: "async", params: {} },
				{ id: "sub", kind: "subflow_entry", params: [] },
				{ id: "watch", kind: "package", package: "bench", node: "probe" },
			],
			edges: [
				{ from: "entry", to: "load", kind: "chain" },
				{ from: "load", to: "spawn", kind: "chain" },
				{ from: "sub", to: "watch", kind: "chain" },
				{ from: "spawn", to: "sub", kind: "dispatch" },
			],
			packages: { bench: "1.0.0" },
		};
		const id = await api.orchestrationWith(document);
		await putFocusItemsOk(api, id, [
			{ node_id: "watch", chart: "level" },
			{ node_id: "load", chart: "延迟" },
		]);
		const runId = await api.triggerOk(id);
		await agent.nextAssign();

		// 子流程要等 load 成功、spawn 执行之后才触发：现在只有 load。
		const early = await focus(runId);
		expect(early.items.map((i) => [i.position, i.node_id])).toEqual([[2, "load"]]);
	});

	it("节点不在这次运行绑定的版本里的项不返回，位置仍按作者的列表", async () => {
		const id = await api.orchestrationWith(benchDocument([["load", "load"]]));
		const runId = await api.triggerOk(id);
		await agent.nextAssign();

		// 之后的版本加了 late 节点，场景把它设成关注项；这次运行用的是旧版本。
		await api.saveVersion(
			id,
			benchDocument([
				["load", "load"],
				["late", "probe"],
			]),
		);
		await putFocusItemsOk(api, id, [
			{ node_id: "late", chart: "level" },
			{ node_id: "load", chart: "延迟" },
		]);

		const result = await focus(runId);
		expect(result.mode).toBe("focus");
		expect(result.items.map((i) => [i.position, i.node_id, i.chart])).toEqual([
			[2, "load", "延迟"],
		]);
	});

	it("这次运行锁定的节点包版本里没有这张图表时写明 chart_missing，其余项照常", async () => {
		// 运行锁定 bench 1.0.0（图表叫 TPS）；之后的版本升到 2.0.0，图表改名为「吞吐」，作者按新名字设了关注项。
		const id = await api.orchestrationWith(benchDocument());
		const runId = await api.triggerOk(id);
		const task = await agent.nextAssign();
		agent.metrics(task, [
			["tps", at(1), 7],
			["p99", at(1), 9],
		]);
		await agent.sync();
		await api.saveVersion(id, benchDocument(undefined, "2.0.0"));
		await putFocusItemsOk(api, id, [
			{ node_id: "load", chart: "吞吐", title: "吞吐量" },
			{ node_id: "load", chart: "延迟" },
		]);

		const [missing, latency] = (await focus(runId)).items;
		expect(missing).toMatchObject({
			position: 1,
			chart: "吞吐",
			title: "吞吐量",
			unavailable: "chart_missing",
			source: { status: "running", attempt: 1, task_id: task.taskId },
			latest: null,
			series: [],
			last_at: null,
		});
		expect(latency).toMatchObject({
			position: 2,
			latest: { value: 9 },
		});
		expect(latency?.unavailable).toBeUndefined();
	});

	it("数值卡只取第一个序列；多序列的图表返回声明的全部序列，latest 取最近更新的那个并带上它的标签", async () => {
		const document = {
			default_agent: "agent-a",
			nodes: [
				{ id: "entry", kind: "entry" },
				{ id: "watch", kind: "package", package: "procs", node: "watch" },
			],
			edges: [{ from: "entry", to: "watch", kind: "chain" }],
			packages: { procs: "1.0.0" },
		};
		const id = await api.orchestrationWith(document);
		await putFocusItemsOk(api, id, [
			{ node_id: "watch", chart: "CPU" },
			{ node_id: "watch", chart: "合计" },
		]);
		const runId = await api.triggerOk(id);
		const task = await agent.nextAssign();
		agent.metrics(task, [
			...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((s) => point("cpu", s, 10 + s, { pid: "100" })),
			...[1, 2, 3, 4].map((s) => point("cpu", s, 50 + s, { pid: "200" })),
			point("mem", 3, 640),
			point("total", 9, 1234),
		]);
		await agent.sync();

		let [cpu, total] = (await focus(runId)).items;
		expect(cpu?.chart_type).toBe("line");
		expect(cpu?.series.map((s) => [s.metric, s.labels, s.points.length])).toEqual([
			["cpu", { pid: "100" }, 9],
			["cpu", { pid: "200" }, 4],
		]);
		expect(cpu?.latest).toEqual({
			value: 19,
			metric: "cpu",
			labels: { pid: "100" },
			at: iso(9),
		});
		expect(cpu?.last_at).toBe(iso(9));
		// 数值卡「合计」引用 mem 和 total，只画第一个指标；total 更新得更晚也不影响。
		expect(total).toMatchObject({
			chart_type: "stat",
			unit: "MB",
			latest: { value: 640, metric: "mem", labels: {}, at: iso(3) },
		});
		expect(total?.series.map((s) => s.metric)).toEqual(["mem"]);

		// 另一个序列更新得更晚时，latest 换成它。
		agent.metrics(task, [point("cpu", 12, 99, { pid: "200" })]);
		await agent.sync();
		[cpu, total] = (await focus(runId)).items;
		expect(cpu?.latest).toEqual({
			value: 99,
			metric: "cpu",
			labels: { pid: "200" },
			at: iso(12),
		});
		expect(cpu?.last_at).toBe(iso(12));
	});

	it("场景没设关注项时，mode 是 primary，返回执行中节点的主指标", async () => {
		const document = {
			default_agent: "agent-a",
			nodes: [
				{ id: "entry", kind: "entry" },
				{ id: "a", kind: "package", package: "prim", node: "work" },
				{ id: "quiet", kind: "package", package: "bench", node: "probe" },
				{ id: "b", kind: "package", package: "prim", node: "work" },
			],
			edges: [
				{ from: "entry", to: "a", kind: "chain" },
				{ from: "a", to: "quiet", kind: "chain" },
				{ from: "quiet", to: "b", kind: "chain" },
			],
			packages: { prim: "1.0.0", bench: "1.0.0" },
		};
		const runId = await api.triggerOk(await api.orchestrationWith(document));
		const a = await agent.nextAssign();
		agent.metrics(a, [
			["done", at(1), 10],
			["done", at(2), 25],
			["rate", at(2), 15],
		]);
		await agent.sync();

		const running = await focus(runId);
		expect(running.mode).toBe("primary");
		expect(running.items).toHaveLength(1);
		expect(running.items[0]).toMatchObject({
			position: 1,
			node_id: "a",
			chart: "done",
			title: "done",
			chart_type: "stat",
			unit: "单",
			source: { status: "running", attempt: 1, task_id: a.taskId },
			latest: { value: 25, at: iso(2) },
			final: false,
			anomaly: null,
		});

		// a 成功后没有主指标的 quiet 执行中：没有可显示的项；b 开始执行后才有。
		await agent.succeed(a);
		const quiet = await agent.nextAssign();
		expect((await focus(runId)).items).toEqual([]);
		await agent.succeed(quiet);
		const b = await agent.nextAssign();
		agent.metrics(b, [["done", at(5), 3]]);
		await agent.sync();
		const next = await focus(runId);
		expect(next.items.map((i) => [i.node_id, i.latest?.value])).toEqual([["b", 3]]);
	});

	it("points 是每个序列降采样的点数：默认 60，0 只要最新值；超过上限是 400", async () => {
		const id = await api.orchestrationWith(benchDocument());
		await putFocusItemsOk(api, id, [{ node_id: "load", chart: "延迟" }]);
		const runId = await api.triggerOk(id);
		const task = await agent.nextAssign();
		agent.metrics(
			task,
			Array.from({ length: 120 }, (_, i): [string, number, number] => ["p99", at(i), i]),
		);
		await agent.sync();

		const byDefault = (await focus(runId)).items[0];
		expect(byDefault?.bucket_seconds).toBe(2);
		expect(byDefault?.series[0]?.points).toHaveLength(60);
		const coarse = (await focus(runId, "?points=6")).items[0];
		expect(coarse?.bucket_seconds).toBe(20);
		expect(coarse?.series[0]?.points).toEqual(
			[0, 20, 40, 60, 80, 100].map((s) => ({
				time: iso(s),
				min: s,
				max: s + 19,
				last: s + 19,
			})),
		);
		expect(coarse?.latest).toMatchObject({ value: 119, at: iso(119) });

		const latestOnly = (await focus(runId, "?points=0")).items[0];
		expect(latestOnly?.series).toEqual([]);
		expect(latestOnly?.latest).toMatchObject({ value: 119, at: iso(119) });
		expect(latestOnly?.last_at).toBe(iso(119));

		expect((await focusRes(runId, "?points=301")).status).toBe(400);
		expect((await focusRes(runId, "?points=-1")).status).toBe(400);
	});

	it("运行不存在、编号不是 UUID 时 404", async () => {
		expect((await focusRes("00000000-0000-4000-8000-000000000000")).status).toBe(404);
		expect((await focusRes("not-a-run")).status).toBe(404);
	});

	it("指标已过保留期的运行：expired 为 true，每一项都没有数据", async () => {
		await agent.disconnect();
		await cp.close();
		// 时钟一次推进几天：任务租约设得更长，免得没有心跳的假 Agent 的任务以 agent_lost 结束。
		cp = await startTestControlPlane({ leaseMs: 400 * DAY, metricRetentionDays: 7 });
		api = new ApiClient(cp);
		await publishBench(cp);
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" }, { clock: cp.clock });
		const id = await api.orchestrationWith(benchDocument([["load", "load"]]));
		await putFocusItemsOk(api, id, [{ node_id: "load", chart: "延迟" }]);
		const runId = await api.triggerOk(id);
		const task = await agent.nextAssign();
		agent.metrics(task, [["p99", at(1), 10]]);
		await agent.succeed(task);
		expect((await focus(runId)).items[0]?.latest).toMatchObject({ value: 10 });

		clock().advance(7 * DAY + 1000);
		await eventually(async () => expect((await focus(runId)).expired).toBe(true));
		const [item] = (await focus(runId)).items;
		expect(item).toMatchObject({ latest: null, last_at: null, source: { status: "success" } });
		expect(item?.series.every((s) => s.points.length === 0)).toBe(true);
	});
});
