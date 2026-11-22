import type { AttemptView, ChainRunView, NodeRunView, RunView } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { toFlowEdge } from "#/components/canvas/flow";
import {
	type EdgeFlow,
	liveEdgeIds,
	nextEdgeFlow,
	nodeElapsed,
	runOverlay,
	withoutErrorClass,
} from "./run-overlay";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

const attempt = (over: Partial<AttemptView>): AttemptView => ({
	task_id: "t",
	attempt: 1,
	status: "success",
	agent: "agent-a",
	inputs: null,
	outputs: null,
	error: null,
	queued_at: at(0),
	started_at: at(0),
	ended_at: at(1),
	start_clock_offset: null,
	end_clock_offset: null,
	progress: null,
	current_action: null,
	queue_wait: null,
	...over,
});

const node = (node_id: string, status: NodeRunView["status"], attempts: AttemptView[] = []) =>
	({
		node_id,
		kind: "package",
		status,
		agent: attempts.at(-1)?.agent ?? null,
		outputs: null,
		error: null,
		attempts,
	}) satisfies NodeRunView;

const chain = (
	over: Partial<ChainRunView> & Pick<ChainRunView, "id" | "chain_id">,
): ChainRunView => ({
	name: null,
	parent_chain_instance_id: null,
	async_node_id: null,
	depth: 0,
	status: "running",
	params: {},
	started_at: at(0),
	ended_at: null,
	nodes: [],
	...over,
});

const run = (chains: ChainRunView[]): RunView => ({
	id: "run-1",
	orchestration_id: "o",
	orchestration_version: 3,
	status: "running",
	triggered_by: "tester",
	triggered_via: null,
	params: {},
	started_at: at(0),
	ended_at: null,
	cancel: null,
	preset: null,
	run_notification: null,
	chains,
});

const main = chain({
	id: "c-main",
	chain_id: "entry",
	nodes: [
		node("entry", "success"),
		node("fetch", "success"),
		node("spawn", "success"),
		node("verify", "running"),
		node("cleanup", "pending"),
	],
});

describe("画布运行状态叠加", () => {
	it("节点按运行里的状态叠加；准备中算执行中，排队算待执行（中性，不是琥珀的等待），成功算完成", () => {
		const overlay = runOverlay(
			run([
				chain({
					...main,
					nodes: [
						node("a", "success"),
						node("b", "dispatched"),
						node("c", "queued"),
						node("d", "failed"),
						node("e", "skipped"),
						node("f", "cancelled"),
						node("g", "waiting"),
						node("h", "pending"),
						node("i", "stopped"),
					],
				}),
			]),
		);
		const states = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map(
			(id) => overlay.node(id)?.state,
		);
		expect(states).toEqual([
			"done",
			"running",
			"pending",
			"failed",
			"skipped",
			"cancelled",
			"waiting",
			"pending",
			"stopped",
		]);
		expect(overlay.node("missing")).toBeUndefined();
	});

	it("线路图：走过的链连线是 travelled，没走到的是 ahead，进入执行中 / 失败 / 等待中节点的是 live / failed / waiting", () => {
		const overlay = runOverlay(
			run([
				chain({
					...main,
					nodes: [
						node("a", "success"),
						node("b", "running"),
						node("c", "failed"),
						node("d", "success"),
						node("e", "waiting"),
						node("f", "pending"),
						node("g", "skipped"),
					],
				}),
			]),
		);
		expect(overlay.edge({ from: "a", to: "b", kind: "chain" })).toBe("live");
		expect(overlay.edge({ from: "a", to: "c", kind: "chain" })).toBe("failed");
		expect(overlay.edge({ from: "a", to: "d", kind: "chain" })).toBe("travelled");
		expect(overlay.edge({ from: "a", to: "e", kind: "chain" })).toBe("waiting");
		expect(overlay.edge({ from: "a", to: "f", kind: "chain" })).toBe("ahead");
		expect(overlay.edge({ from: "a", to: "g", kind: "chain" })).toBe("ahead");
		// 起点还没完成：后面都还没走到。
		expect(overlay.edge({ from: "b", to: "c", kind: "chain" })).toBe("ahead");
		// 没有运行记录的节点（子流程没有触发）。
		expect(overlay.edge({ from: "missing", to: "a", kind: "chain" })).toBe("ahead");
	});

	it("调度连线：子流程有实例还在运行时是 live，结束了或没有触发是 ended", () => {
		const overlay = runOverlay(
			run([
				chain({ ...main, nodes: [node("spawn", "success"), node("spawn2", "success")] }),
				chain({
					id: "c-sub",
					chain_id: "sub",
					name: "sub",
					parent_chain_instance_id: main.id,
					async_node_id: "spawn",
					depth: 1,
					status: "running",
					nodes: [node("sub", "success"), node("x", "running")],
				}),
				chain({
					id: "c-done",
					chain_id: "done_sub",
					name: "done_sub",
					parent_chain_instance_id: main.id,
					async_node_id: "spawn2",
					depth: 1,
					status: "failed",
					nodes: [node("done_sub", "success"), node("y", "failed")],
				}),
			]),
		);
		expect(overlay.edge({ from: "spawn", to: "sub", kind: "dispatch" })).toBe("live");
		expect(overlay.edge({ from: "spawn2", to: "done_sub", kind: "dispatch" })).toBe("ended");
		expect(overlay.edge({ from: "spawn2", to: "never", kind: "dispatch" })).toBe("ended");
	});

	it("子流程节点取第一个实例（与监控页 ?node= 定位的实例一致），并给出实例数；没有触发的子流程没有实例", () => {
		const sub = (id: string, start: number, status: NodeRunView["status"]) =>
			chain({
				id,
				chain_id: "sub",
				parent_chain_instance_id: "c-main",
				async_node_id: "spawn",
				depth: 1,
				started_at: at(start),
				nodes: [node("sub", "success"), node("probe", status)],
			});
		const overlay = runOverlay(run([main, sub("c-2", 5, "running"), sub("c-1", 2, "failed")]));
		const probe = overlay.node("probe");
		expect(probe?.chain.id).toBe("c-1");
		expect(probe?.state).toBe("failed");
		expect(probe?.instances).toBe(2);
		expect(overlay.instances("sub").map((c) => c.id)).toEqual(["c-1", "c-2"]);
		expect(overlay.instances("other")).toEqual([]);
	});
});

describe("执行中的节点", () => {
	it("准备中和执行中都算，按节点 ID 排序；子流程里的节点也在内", () => {
		const sub = chain({
			id: "c-sub",
			chain_id: "sub",
			parent_chain_instance_id: "c-main",
			async_node_id: "spawn",
			depth: 1,
			nodes: [node("sub", "success"), node("probe", "dispatched"), node("later", "pending")],
		});
		const overlay = runOverlay(
			run([
				chain({
					...main,
					nodes: [node("entry", "success"), node("verify", "running"), node("cleanup", "pending")],
				}),
				sub,
			]),
		);
		expect(overlay.running).toEqual(["probe", "verify"]);
	});

	it("没有节点在执行时是空的", () => {
		const overlay = runOverlay(
			run([chain({ ...main, nodes: [node("a", "success"), node("b", "waiting")] })]),
		);
		expect(overlay.running).toEqual([]);
	});
});

describe("连线流动", () => {
	const edges = [
		["entry", "fetch"],
		["fetch", "spawn"],
		["spawn", "verify"],
		["verify", "cleanup"],
	].map(([from, to]) => toFlowEdge({ from: from as string, to: to as string, kind: "chain" }));
	const seen = (statuses: [string, NodeRunView["status"]][]) =>
		liveEdgeIds(
			runOverlay(
				run([chain({ ...main, nodes: statuses.map(([id, status]) => node(id, status)) })]),
			),
			edges,
		);
	const flow = (before: EdgeFlow | null, live: ReadonlySet<string>) => nextEdgeFlow(before, live);
	const ids = (set: ReadonlySet<string>) => [...set].sort();

	it("进入执行中节点的链连线是 live；调度连线、进入失败节点的连线不是", () => {
		const live = seen([
			["entry", "success"],
			["fetch", "success"],
			["spawn", "running"],
			["verify", "pending"],
		]);
		expect(ids(live)).toEqual(["chain:fetch->spawn"]);
		const failed = seen([
			["entry", "success"],
			["fetch", "failed"],
		]);
		expect(ids(failed)).toEqual([]);
	});

	it("刚打开页面时已经在执行的连线是静止的：只有之后才变成执行中的连线才流动", () => {
		const open = flow(
			null,
			seen([
				["entry", "success"],
				["fetch", "running"],
			]),
		);
		expect(ids(open.live)).toEqual(["chain:entry->fetch"]);
		expect(ids(open.entering)).toEqual([]);
	});

	it("执行推进一步：新变成执行中的那一段流动，上一段不再是执行中", () => {
		const open = flow(
			null,
			seen([
				["entry", "success"],
				["fetch", "running"],
			]),
		);
		const next = flow(
			open,
			seen([
				["entry", "success"],
				["fetch", "success"],
				["spawn", "running"],
			]),
		);
		expect(ids(next.live)).toEqual(["chain:fetch->spawn"]);
		expect(ids(next.entering)).toEqual(["chain:fetch->spawn"]);
	});

	it("同一段连线之后的更新不改变结果，流动的动画不会被中途掐断，也不会重新开始", () => {
		const open = flow(null, seen([["entry", "success"]]));
		const step = seen([
			["entry", "success"],
			["fetch", "success"],
			["spawn", "running"],
		]);
		const first = flow(open, step);
		const again = flow(first, new Set(step));
		expect(ids(again.entering)).toEqual(["chain:fetch->spawn"]);
		expect(again).toBe(first);
	});

	it("节点失败后重试，连线再次变成执行中时重新流动", () => {
		const running = seen([
			["entry", "success"],
			["fetch", "success"],
			["spawn", "success"],
			["verify", "running"],
		]);
		const failed = seen([
			["entry", "success"],
			["fetch", "success"],
			["spawn", "success"],
			["verify", "failed"],
		]);
		const open = flow(null, running);
		const afterFail = flow(open, failed);
		expect(ids(afterFail.entering)).toEqual([]);
		const retried = flow(afterFail, running);
		expect(ids(retried.entering)).toEqual(["chain:spawn->verify"]);
	});
});

describe("节点耗时", () => {
	it("从第一次尝试开始到最后一次尝试结束；执行中算到现在；没有开始过的没有耗时", () => {
		const done = node("a", "success", [
			attempt({ started_at: at(2), ended_at: at(5) }),
			attempt({ attempt: 2, started_at: at(6), ended_at: at(9) }),
		]);
		expect(nodeElapsed(done, T0 + 60_000)).toBe(7000);
		const running = node("b", "running", [attempt({ started_at: at(4), ended_at: null })]);
		expect(nodeElapsed(running, T0 + 10_000)).toBe(6000);
		const queued = node("c", "queued", [attempt({ started_at: null, ended_at: null })]);
		expect(nodeElapsed(queued, T0 + 10_000)).toBeNull();
		expect(nodeElapsed(node("d", "pending"), T0)).toBeNull();
	});
});

describe("卡片上的失败原因", () => {
	it("去掉开头的异常类名，带模块路径的也去掉", () => {
		expect(withoutErrorClass("AssertionError: 漏拦 3 笔")).toBe("漏拦 3 笔");
		expect(withoutErrorClass("RuntimeError：磁盘使用率 97%")).toBe("磁盘使用率 97%");
		expect(withoutErrorClass("requests.exceptions.ConnectionError: 连接被重置")).toBe("连接被重置");
		expect(withoutErrorClass("ValueException: bad")).toBe("bad");
	});
	it("没有类名、只有类名或类名不在开头时保留原文", () => {
		expect(withoutErrorClass("超时")).toBe("超时");
		expect(withoutErrorClass("TimeoutError")).toBe("TimeoutError");
		expect(withoutErrorClass("TimeoutError: ")).toBe("TimeoutError: ");
		expect(withoutErrorClass("调用失败: KeyError: x")).toBe("调用失败: KeyError: x");
	});
});
