import type { AttemptView, ChainRunView, NodeRunView, RunView } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { errorSummary, nodeElapsed, runOverlay } from "./run-overlay";

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
	wake_at: null,
	progress: null,
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
	it("节点按运行里的状态叠加；准备中算执行中，排队算等待，成功算完成", () => {
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
			"waiting",
			"failed",
			"skipped",
			"cancelled",
			"waiting",
			"pending",
			"stopped",
		]);
		expect(overlay.node("missing")).toBeUndefined();
	});

	it("进入执行中节点的链连线是 live，进入失败节点的是 failed；调度连线不叠加", () => {
		const overlay = runOverlay(
			run([
				chain({
					...main,
					nodes: [node("a", "success"), node("b", "running"), node("c", "failed")],
				}),
			]),
		);
		expect(overlay.edge({ from: "a", to: "b", kind: "chain" })).toBe("live");
		expect(overlay.edge({ from: "b", to: "c", kind: "chain" })).toBeUndefined();
		expect(overlay.edge({ from: "a", to: "c", kind: "chain" })).toBe("failed");
		expect(overlay.edge({ from: "a", to: "b", kind: "dispatch" })).toBeUndefined();
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

describe("错误摘要", () => {
	it("只取空行之前的部分（之后是堆栈）", () => {
		expect(errorSummary({ kind: "node_error", message: "漏拦 3 笔\n\nTraceback ..." })).toBe(
			"漏拦 3 笔",
		);
		expect(errorSummary({ kind: "timeout", message: "超时" })).toBe("超时");
	});
});
