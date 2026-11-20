import type { AttemptView, ChainRunView, NodeRunView, RunView } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	EMPTY_SCOPE,
	reduceScope,
	resolveScope,
	type ScopeEvent,
	type ScopeState,
} from "./monitor-scope";
import type { NodeRef } from "./node-ref";

/** 运行开始之后第 s 秒（控制面时间，毫秒）。 */
const at = (s: number) => Date.UTC(2026, 0, 1, 0, 0, s);
const iso = (s: number) => new Date(at(s)).toISOString();

const attempt = (
	node: string,
	n: number,
	status: AttemptView["status"],
	startedAt: number | null,
): AttemptView => ({
	task_id: `${node}-task-${n}`,
	attempt: n,
	status,
	agent: "agent-a",
	inputs: {},
	outputs: null,
	error: status === "failed" ? { kind: "node_error", message: "boom" } : null,
	queued_at: iso(0),
	started_at: startedAt === null ? null : iso(startedAt),
	ended_at: status === "running" ? null : iso((startedAt ?? 0) + 2),
	start_clock_offset: null,
	end_clock_offset: null,
	wake_at: null,
	progress: null,
	current_action: null,
});

const node = (id: string, status: NodeRunView["status"], attempts: AttemptView[]): NodeRunView => ({
	node_id: id,
	kind: "package",
	status,
	agent: "agent-a",
	outputs: null,
	error: attempts.at(-1)?.error ?? null,
	attempts,
});

const main = (nodes: NodeRunView[]): ChainRunView => ({
	id: "main",
	chain_id: "entry",
	name: null,
	parent_chain_instance_id: null,
	async_node_id: null,
	depth: 0,
	status: "running",
	params: {},
	started_at: iso(0),
	ended_at: null,
	nodes,
});

const runOf = (nodes: NodeRunView[]): RunView => ({
	id: "00000000-0000-4000-8000-000000000001",
	orchestration_id: "00000000-0000-4000-8000-0000000000f1",
	orchestration_version: 1,
	status: "running",
	triggered_by: "tester",
	triggered_via: null,
	params: {},
	started_at: iso(0),
	ended_at: null,
	cancel: null,
	preset: null,
	run_notification: null,
	chains: [main(nodes)],
});

const ref = (nodeId: string): NodeRef => ({ chainInstanceId: "main", nodeId });

/**
 * fetch 一次尝试（第 1 秒开始）；verify 失败过一次再重试：第 1 次尝试从第 6 秒、第 2 次从第 9 秒开始，
 * 第 2 次还在执行；report 还没有开始。
 */
const run = runOf([
	node("fetch", "success", [attempt("fetch", 1, "success", 1)]),
	node("verify", "running", [
		attempt("verify", 1, "failed", 6),
		attempt("verify", 2, "running", 9),
	]),
	node("report", "pending", []),
]);

/** 依次报告这些事，再对着运行视图读现在的范围。 */
const play = (events: ScopeEvent[], on: RunView = run) => {
	const state = events.reduce(reduceScope, EMPTY_SCOPE);
	return { state, scope: resolveScope(state, on) };
};
const select = (nodeId: string): ScopeEvent => ({ type: "select", node: ref(nodeId) });
const attemptNumber = (events: ScopeEvent[], on: RunView = run) =>
	play(events, on).scope.attempt?.attempt;

describe("范围：看的是哪一次尝试", () => {
	it("没有指定过尝试时看节点最近的一次；运行中重试出了新的一次，看的跟着换", () => {
		const { state, scope } = play([select("verify")]);
		expect(scope.attempt?.task_id).toBe("verify-task-2");
		const retried = runOf([
			node("verify", "running", [
				attempt("verify", 1, "failed", 6),
				attempt("verify", 2, "failed", 9),
				attempt("verify", 3, "running", 12),
			]),
		]);
		expect(resolveScope(state, retried).attempt?.attempt).toBe(3);
	});

	it("没有选中节点、选中的节点还没有开始：没有尝试", () => {
		expect(play([]).scope.attempt).toBeUndefined();
		expect(play([select("report")]).scope.attempt).toBeUndefined();
	});

	it("手动切到节点的另一次尝试", () => {
		expect(attemptNumber([select("verify"), { type: "attempt", taskId: "verify-task-1" }])).toBe(1);
	});

	it("换了节点回到最近一次尝试：手动切到的尝试不带到别的节点，选回来也不恢复", () => {
		const first: ScopeEvent = { type: "attempt", taskId: "verify-task-1" };
		expect(attemptNumber([select("verify"), first, select("fetch")])).toBe(1);
		expect(attemptNumber([select("verify"), first, select("fetch"), select("verify")])).toBe(2);
		expect(
			attemptNumber([select("verify"), first, { type: "select", node: null }, select("verify")]),
		).toBe(2);
	});

	it("选中已经选中的节点不算换节点：手动切到的尝试保留", () => {
		expect(
			attemptNumber([
				select("verify"),
				{ type: "attempt", taskId: "verify-task-1" },
				select("verify"),
			]),
		).toBe(1);
	});

	it("点合并日志里的来源节点名：选中这个节点，看那一行所在的尝试，不是最近一次", () => {
		const { scope } = play([{ type: "origin", node: ref("verify"), taskId: "verify-task-1" }]);
		expect(scope.selected).toEqual(ref("verify"));
		expect(scope.attempt?.attempt).toBe(1);
	});

	it("点来源时运行视图里还没有那一次尝试：先看最近一次，运行视图里有了就看那一次", () => {
		const { state, scope } = play([
			{ type: "origin", node: ref("verify"), taskId: "verify-task-3" },
		]);
		expect(scope.attempt?.attempt).toBe(2);
		const retried = runOf([
			node("verify", "running", [
				attempt("verify", 1, "failed", 6),
				attempt("verify", 2, "failed", 9),
				attempt("verify", 3, "running", 12),
			]),
		]);
		expect(resolveScope(state, retried).attempt?.attempt).toBe(3);
	});
});

describe("范围：定位日志", () => {
	const locate = (nodeId: string, seconds: number): ScopeEvent => ({
		type: "locate",
		node: ref(nodeId),
		at: at(seconds),
	});

	it("选中节点，切到日志页签并展开面板，记下要定位的时刻", () => {
		const { scope } = play([
			{ type: "failure", node: ref("fetch") },
			{ type: "panel", open: false },
			locate("verify", 7),
		]);
		expect(scope).toMatchObject({
			selected: ref("verify"),
			tab: "logs",
			open: true,
			locate: { at: at(7) },
		});
	});

	it("时刻落在哪一次尝试里就看哪一次：开始时间不晚于那一刻的最后一次", () => {
		expect(attemptNumber([locate("verify", 7)])).toBe(1);
		expect(attemptNumber([locate("verify", 8.999)])).toBe(1);
		expect(attemptNumber([locate("verify", 9)])).toBe(2);
		expect(attemptNumber([locate("verify", 600)])).toBe(2);
	});

	it("早于所有尝试的时刻：看最近一次，仍然定位到那一刻", () => {
		const { scope } = play([locate("verify", 2)]);
		expect(scope.attempt?.attempt).toBe(2);
		expect(scope.locate).toMatchObject({ at: at(2) });
	});

	it("手动切到别的尝试后不再定位：那一刻不在它的日志里；切回定位到的那一次又定位", () => {
		const events = [locate("verify", 7)];
		const { scope: located } = play(events);
		expect(located.locate).not.toBeNull();
		const { scope: other } = play([...events, { type: "attempt", taskId: "verify-task-2" }]);
		expect(other.attempt?.attempt).toBe(2);
		expect(other.locate).toBeNull();
		const { scope: back } = play([
			...events,
			{ type: "attempt", taskId: "verify-task-2" },
			{ type: "attempt", taskId: "verify-task-1" },
		]);
		expect(back.locate).toEqual(located.locate);
	});

	it("再定位一次回到那一刻所在的尝试：覆盖手动切的尝试", () => {
		const { scope } = play([
			locate("verify", 7),
			{ type: "attempt", taskId: "verify-task-2" },
			locate("verify", 7),
		]);
		expect(scope.attempt?.attempt).toBe(1);
		expect(scope.locate).not.toBeNull();
	});

	it("同一个时刻再请求一次，请求号也变：读者可能已经滚到别处，要重新定位", () => {
		const first = play([locate("verify", 7)]).scope.locate;
		const again = play([locate("verify", 7), locate("verify", 7)]).scope.locate;
		expect(again?.at).toBe(first?.at);
		expect(again?.request).not.toBe(first?.request);
	});

	it("定位的请求只对请求时的节点有效：选中别的节点时不定位，选回来仍是那一次请求", () => {
		const located = play([locate("verify", 7)]).scope.locate;
		expect(play([locate("verify", 7), select("fetch")]).scope.locate).toBeNull();
		expect(play([locate("verify", 7), select("fetch"), select("verify")]).scope.locate).toEqual(
			located,
		);
	});

	it("没有选中节点的范围里没有定位", () => {
		expect(play([locate("verify", 7), { type: "select", node: null }]).scope.locate).toBeNull();
	});
});

describe("范围：看失败的节点", () => {
	it("选中这个节点，切到「尝试」页签并展开面板", () => {
		const { scope } = play([
			{ type: "locate", node: ref("fetch"), at: at(2) },
			{ type: "panel", open: false },
			{ type: "failure", node: ref("verify") },
		]);
		expect(scope).toMatchObject({ selected: ref("verify"), tab: "attempts", open: true });
	});

	it("换了节点回到最近一次尝试", () => {
		expect(
			attemptNumber([
				select("verify"),
				{ type: "attempt", taskId: "verify-task-1" },
				{ type: "failure", node: ref("fetch") },
				{ type: "failure", node: ref("verify") },
			]),
		).toBe(2);
	});
});

describe("范围：底部面板的页签与展开", () => {
	const logsEmpty = (empty: boolean): ScopeEvent => ({ type: "logsEmpty", empty });

	it("用户没选过：日志页签没有内容就收起，内容到了再展开", () => {
		expect(play([]).scope.open).toBe(true);
		expect(play([logsEmpty(true)]).scope.open).toBe(false);
		expect(play([logsEmpty(true), logsEmpty(false)]).scope.open).toBe(true);
	});

	it("选中的节点还没有开始：没有日志可看，收起", () => {
		expect(play([select("report")]).scope.open).toBe(false);
		expect(play([select("report"), select("fetch")]).scope.open).toBe(true);
	});

	it("自动决定时内容也要挂着（日志到了才能自动展开）；用户选过之后不再自动", () => {
		expect(play([logsEmpty(true)]).scope.auto).toBe(true);
		expect(play([logsEmpty(true), { type: "panel", open: true }]).scope.auto).toBe(false);
		expect(play([{ type: "panel", open: false }]).scope.auto).toBe(false);
	});

	it("只有日志页签按内容自动收起：别的页签总是展开", () => {
		const { scope } = play([logsEmpty(true), { type: "tab", tab: "io" }]);
		expect(scope.open).toBe(true);
		expect(
			play([select("report"), { type: "panel", open: null }, { type: "tab", tab: "io" }]).scope
				.open,
		).toBe(true);
	});

	it("切页签是用户的选择：面板随之展开，之后不再按内容自动收起", () => {
		const { scope } = play([logsEmpty(true), { type: "tab", tab: "logs" }]);
		expect(scope).toMatchObject({ tab: "logs", open: true, auto: false });
	});

	it("用户展开了就不再因为没有日志收起；收起了就不再因为日志到了展开", () => {
		expect(play([{ type: "panel", open: true }, logsEmpty(true)]).scope.open).toBe(true);
		expect(play([{ type: "panel", open: false }, logsEmpty(false)]).scope.open).toBe(false);
	});

	it("恢复默认（open 为 null）：回到按内容自动决定", () => {
		const events: ScopeEvent[] = [{ type: "panel", open: true }, logsEmpty(true)];
		expect(play(events).scope.open).toBe(true);
		expect(play([...events, { type: "panel", open: null }]).scope.open).toBe(false);
	});
});

describe("没有变化时返回原来的状态", () => {
	it("同样的事再报告一次：状态是同一个对象，订阅的组件不会重新渲染", () => {
		const events: ScopeEvent[] = [
			select("verify"),
			{ type: "attempt", taskId: "verify-task-1" },
			{ type: "logsEmpty", empty: true },
			{ type: "tab", tab: "attempts" },
			{ type: "panel", open: true },
		];
		const state = events.reduce<ScopeState>(reduceScope, EMPTY_SCOPE);
		for (const event of events) expect(reduceScope(state, event)).toBe(state);
	});
});
