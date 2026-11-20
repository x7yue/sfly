import type { AttemptView, ChainRunView, NodeRunView, RunView } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	EMPTY_SCOPE,
	openedScope,
	panelOpen,
	readsLogs,
	reduceScope,
	resolveScope,
	type ScopeEvent,
	type ScopeState,
} from "./monitor-scope";
import type { NodeRef } from "./node-ref";
import type { MonitorSearch } from "./run-link";

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
	error: status === "failed" ? { kind: "node_error", message: "boom", location: null } : null,
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
/** 在 fetch 之后 verify 最终失败的运行。 */
const failedRun: RunView = {
	...runOf([
		node("fetch", "success", [attempt("fetch", 1, "success", 1)]),
		node("verify", "failed", [
			attempt("verify", 1, "failed", 6),
			attempt("verify", 2, "failed", 9),
		]),
	]),
	status: "failed",
};

const select = (nodeId: string): ScopeEvent => ({ type: "select", node: ref(nodeId) });
const address = (a: MonitorSearch, on: RunView = run): ScopeEvent => ({
	type: "address",
	run: on,
	address: a,
});
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

	it("点合并日志里的来源节点：选中这个节点，看那一行所在的尝试，不是最近一次", () => {
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

describe("范围：手动选的尝试只在详情里算数", () => {
	const first: ScopeEvent = { type: "attempt", taskId: "verify-task-1" };
	const leave: ScopeEvent = { type: "view", view: "overview" };
	const back: ScopeEvent = { type: "view", view: "detail" };

	it("切到概览再回详情：手动切的尝试丢掉，看的是最近一次；选中的节点、页签、展开不丢", () => {
		const { scope } = play([
			select("verify"),
			first,
			{ type: "tab", tab: "attempts" },
			leave,
			back,
		]);
		expect(scope).toMatchObject({ selected: ref("verify"), tab: "attempts", panel: true });
		expect(scope.attempt?.attempt).toBe(2);
	});

	it("点来源节点带来的尝试也一样", () => {
		const origin: ScopeEvent = { type: "origin", node: ref("verify"), taskId: "verify-task-1" };
		expect(attemptNumber([origin])).toBe(1);
		expect(attemptNumber([origin, leave, back])).toBe(2);
	});

	it("在概览里点同一个节点的直达项：看的也是默认的那一次尝试", () => {
		const jump: ScopeEvent = { type: "overview", run, address: { view: "detail", node: "verify" } };
		expect(attemptNumber([select("verify"), first, leave, jump, back])).toBe(2);
	});

	it("定位的时刻落在的那一次是默认的：手动切走再离开详情，回来又定位到那一次", () => {
		const { scope } = play([
			{ type: "locate", node: ref("verify"), at: at(7) },
			{ type: "attempt", taskId: "verify-task-2" },
			leave,
			back,
		]);
		expect(scope.attempt?.attempt).toBe(1);
		expect(scope.locate).toMatchObject({ at: at(7) });
	});

	it("还在详情里（页面打开时报告一次、再报告详情）不丢手动切的尝试", () => {
		expect(attemptNumber([select("verify"), first, back, back])).toBe(1);
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
			panel: true,
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
		expect(scope).toMatchObject({ selected: ref("verify"), tab: "attempts", panel: true });
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
	/** 现在面板是否展开；`logsEmpty` 是日志页签读完了、没有任何日志。 */
	const open = (events: ScopeEvent[], logsEmpty = false) => {
		const { scope } = play(events);
		return panelOpen(scope, logsEmpty);
	};

	it("用户没选过：日志页签读完是空的就收起，内容到了再展开", () => {
		expect(open([])).toBe(true);
		expect(open([], true)).toBe(false);
		expect(open([], false)).toBe(true);
	});

	it("选中的节点还没有开始：没有日志可看，收起", () => {
		expect(open([select("report")])).toBe(false);
		expect(open([select("report"), select("fetch")])).toBe(true);
	});

	it("只有日志页签按内容自动收起：别的页签总是展开", () => {
		expect(open([{ type: "tab", tab: "io" }], true)).toBe(true);
		expect(open([select("report"), { type: "tab", tab: "io" }])).toBe(true);
	});

	it("切页签是用户的选择：面板随之展开，之后不再按内容自动收起", () => {
		const events: ScopeEvent[] = [select("report"), { type: "tab", tab: "logs" }];
		expect(play(events).scope).toMatchObject({ tab: "logs", panel: true });
		expect(open(events, true)).toBe(true);
	});

	it("用户展开了就不再因为没有日志收起；收起了就不再因为日志到了展开", () => {
		expect(open([{ type: "panel", open: true }], true)).toBe(true);
		expect(open([{ type: "panel", open: false }], false)).toBe(false);
	});

	it("恢复默认（open 为 null）：回到按内容自动决定", () => {
		const events: ScopeEvent[] = [{ type: "panel", open: true }];
		expect(open(events, true)).toBe(true);
		expect(open([...events, { type: "panel", open: null }], true)).toBe(false);
	});

	it("日志页签要读日志：在日志页签、用户没有收起面板；自动收起时也要读，日志到了才能自动展开", () => {
		const reads = (events: ScopeEvent[]) => readsLogs(play(events).scope);
		expect(reads([])).toBe(true);
		expect(reads([select("report")])).toBe(true);
		expect(reads([{ type: "panel", open: false }])).toBe(false);
		expect(
			reads([
				{ type: "panel", open: false },
				{ type: "tab", tab: "logs" },
			]),
		).toBe(true);
		expect(reads([{ type: "tab", tab: "io" }])).toBe(false);
	});
});

describe("范围：地址", () => {
	const opened = (a: MonitorSearch, on: RunView = run) => resolveScope(openedScope(on, a), on);

	it("打开页面时默认选中第一个失败的节点；地址里给了节点时用地址里的", () => {
		expect(opened({}, failedRun).selected).toEqual(ref("verify"));
		expect(opened({ node: "fetch" }, failedRun).selected).toEqual(ref("fetch"));
	});

	it("没有失败的节点时不默认选中，执行中的节点也不默认选中", () => {
		expect(opened({}).selected).toBeNull();
		expect(opened({ node: "不存在的节点" }).selected).toBeNull();
		expect(opened({ node: "不存在的节点" }, failedRun).selected).toEqual(ref("verify"));
	});

	it("地址里的页签：切过去并展开面板；没给页签时是日志页签、按内容自动展开", () => {
		expect(opened({ node: "fetch", tab: "attempts" })).toMatchObject({
			tab: "attempts",
			panel: true,
		});
		expect(opened({ node: "fetch" })).toMatchObject({ tab: "logs", panel: null });
	});

	it("带了时刻又给了运行里有的节点：选中它，打开日志页签，定位到那一刻", () => {
		expect(opened({ node: "verify", at: iso(7) })).toMatchObject({
			selected: ref("verify"),
			tab: "logs",
			panel: true,
			locate: { at: at(7) },
			attempt: { attempt: 1 },
		});
	});

	it("给了页签时页签优先于定位打开的日志页签，定位仍然有效", () => {
		const scope = opened({ node: "verify", tab: "attempts", at: iso(7) });
		expect(scope.tab).toBe("attempts");
		expect(scope.locate).toMatchObject({ at: at(7) });
	});

	it("时刻不合法、没有节点、或节点不在运行里（回退到失败的节点）：不定位", () => {
		expect(opened({ node: "verify", at: "昨天下午" }).locate).toBeNull();
		expect(opened({ at: iso(7) }, failedRun).locate).toBeNull();
		expect(opened({ node: "不存在的节点", at: iso(7) }, failedRun)).toMatchObject({
			selected: ref("verify"),
			locate: null,
		});
	});

	it("页面打开之后地址变了：再应用一次，选中新的节点、定位到新的时刻", () => {
		const { scope } = play([
			address({ node: "fetch" }),
			address({ node: "verify", tab: "logs", at: iso(7) }),
		]);
		expect(scope).toMatchObject({ selected: ref("verify"), locate: { at: at(7) } });
		const { scope: later } = play([
			address({ node: "verify", tab: "logs", at: iso(7) }),
			address({ node: "verify", tab: "logs", at: iso(10) }),
		]);
		expect(later.locate).toMatchObject({ at: at(10) });
		expect(later.attempt?.attempt).toBe(2);
	});

	it("页面里自己的操作不写回地址：同一个地址再报告也不撤销它们", () => {
		const opening = address({ node: "fetch", tab: "io" });
		const { scope } = play([
			opening,
			select("verify"),
			{ type: "tab", tab: "logs" },
			{ type: "panel", open: false },
			opening,
			opening,
		]);
		expect(scope).toMatchObject({ selected: ref("verify"), tab: "logs", panel: false });
		// 页面里清除了选中，同一个地址也不会再把失败的节点选回来。
		const { scope: cleared } = play(
			[address({}, failedRun), { type: "select", node: null }, address({}, failedRun)],
			failedRun,
		);
		expect(cleared.selected).toBeNull();
	});

	it("视图（概览、详情）不算地址里决定打开哪里的部分：只有视图变了不重置选中的节点", () => {
		const { scope } = play([
			address({ view: "detail", node: "fetch" }),
			select("verify"),
			address({ view: "overview", node: "fetch" }),
		]);
		expect(scope.selected).toEqual(ref("verify"));
	});

	it("概览里点一项直达：地址和上一次一样也照做，切回概览再点一次要重新定位", () => {
		const target: MonitorSearch = { view: "detail", node: "verify", tab: "logs", at: iso(7) };
		const jump: ScopeEvent = { type: "overview", run, address: target };
		const first = play([jump]).scope.locate;
		const { scope } = play([jump, select("fetch"), jump]);
		expect(scope.selected).toEqual(ref("verify"));
		expect(scope.locate?.at).toBe(first?.at);
		expect(scope.locate?.request).toBeGreaterThan(first?.request ?? 0);
		// 直达之后路由带着同一个地址再来一次，不重复应用。
		expect(play([jump, select("fetch"), address(target)]).scope.selected).toEqual(ref("fetch"));
	});
});

describe("没有变化时返回原来的状态", () => {
	it("同样的事再报告一次：状态是同一个对象，订阅的组件不会重新渲染", () => {
		const events: ScopeEvent[] = [
			select("verify"),
			{ type: "attempt", taskId: "verify-task-1" },
			{ type: "tab", tab: "attempts" },
			{ type: "panel", open: true },
		];
		const state = events.reduce<ScopeState>(reduceScope, EMPTY_SCOPE);
		for (const event of events) expect(reduceScope(state, event)).toBe(state);
		// 没有手动选过尝试时换视图也没有变化。
		const picked = reduceScope(EMPTY_SCOPE, select("verify"));
		expect(reduceScope(picked, { type: "view", view: "overview" })).toBe(picked);
	});
});
