import type {
	AttemptView,
	ChainRunView,
	NodeRunView,
	RunView,
	TaskProgressView,
} from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	applyProgress,
	chainLabel,
	chainLabelParts,
	failureSummary,
	focusNode,
	initialSelection,
	latestRunView,
	logOrigin,
	logScope,
	nextFailure,
	progressLabel,
	runDocumentTitle,
	runFailure,
} from "./run-model";

const view = (status: RunView["status"], cancelled = false): RunView => ({
	id: "00000000-0000-4000-8000-000000000001",
	orchestration_id: "00000000-0000-4000-8000-0000000000f1",
	orchestration_version: 1,
	status,
	triggered_by: "tester",
	triggered_via: null,
	params: {},
	started_at: "2026-01-01T00:00:00.000Z",
	ended_at: status === "running" ? null : "2026-01-01T00:00:05.000Z",
	cancel: cancelled
		? {
				requested_by: "tester",
				requested_via: null,
				requested_at: "2026-01-01T00:00:03.000Z",
				forced_at: null,
			}
		: null,
	run_notification: null,
	chains: [],
});

describe("运行视图的合并（#47）", () => {
	it("已结束的视图不被运行中的视图覆盖：运行结束前生成、之后才到达的响应不改回运行中", () => {
		const ended = view("cancelled", true);
		expect(latestRunView(ended, view("running", true))).toBe(ended);
		const failed = view("failed");
		expect(latestRunView(failed, view("running"))).toBe(failed);
	});

	it("其余情况都用新到的视图", () => {
		const running = view("running", true);
		expect(latestRunView(undefined, running)).toBe(running);
		expect(latestRunView(view("running"), running)).toBe(running);
		const ended = view("cancelled", true);
		expect(latestRunView(view("running", true), ended)).toBe(ended);
		const success = view("success");
		expect(latestRunView(view("failed"), success)).toBe(success);
	});
});

describe("运行通知状态的合并（#258）", () => {
	const notified = (status: "queued" | "delivered" | "failed" | "discarded"): RunView => ({
		...view("failed"),
		run_notification: {
			status,
			bot: "压测群",
			reason: status === "failed" || status === "discarded" ? "投递失败的原因" : null,
		},
	});

	it("已有结果的通知状态不被排队中的视图覆盖：投递之前生成、之后才到达的响应不改回排队中", () => {
		for (const settled of ["delivered", "failed", "discarded"] as const) {
			const cached = notified(settled);
			expect(latestRunView(cached, notified("queued")).run_notification).toEqual(
				cached.run_notification,
			);
		}
	});

	it("覆盖通知状态时视图的其余部分仍用新到的", () => {
		const cached = notified("failed");
		const next: RunView = { ...notified("queued"), orchestration_version: 2 };
		const merged = latestRunView(cached, next);
		expect(merged.orchestration_version).toBe(2);
		expect(merged.run_notification).toEqual(cached.run_notification);
	});

	it("其余情况都用新到的视图：排队中变成有结果，或还没有通知状态", () => {
		const settled = notified("delivered");
		expect(latestRunView(notified("queued"), settled)).toBe(settled);
		const queued = notified("queued");
		expect(latestRunView(notified("queued"), queued)).toBe(queued);
		expect(latestRunView(view("failed"), queued)).toBe(queued);
		expect(latestRunView(notified("failed"), notified("failed"))).toEqual(notified("failed"));
	});
});

describe("子流程名称（#80 故事 1、23）", () => {
	const chain = (over: Partial<ChainRunView>): ChainRunView => ({
		id: "6f1c2d3e-0000-4000-8000-000000000002",
		chain_id: "mon",
		name: "监控",
		parent_chain_instance_id: "6f1c2d3e-0000-4000-8000-000000000001",
		async_node_id: "spawn",
		depth: 1,
		status: "running",
		params: {},
		started_at: "2026-01-01T00:00:00.000Z",
		ended_at: null,
		nodes: [],
		...over,
	});

	it("链名显示子流程名称；名称为空时显示「未命名子流程」，主链显示「主链」", () => {
		expect(chainLabel(chain({}))).toBe("子流程 监控 · 6f1c2d3e");
		expect(chainLabel(chain({ name: "" }))).toBe("子流程 未命名子流程 · 6f1c2d3e");
		expect(chainLabel(chain({ depth: 0, name: null, chain_id: "entry" }))).toBe("主链");
	});

	it("链名拆成名称和实例短 ID 两段，拼起来与完整链名一致", () => {
		const sub = chain({});
		expect(chainLabelParts(sub)).toEqual({ name: "子流程 监控", id: "6f1c2d3e" });
		expect(`${chainLabelParts(sub).name} · ${chainLabelParts(sub).id}`).toBe(chainLabel(sub));
		const main = chain({ depth: 0, name: null, chain_id: "entry" });
		expect(chainLabelParts(main)).toEqual({ name: "主链", id: null });
	});
});

describe("合并日志的来源节点（#222）", () => {
	const node = (id: string, attempts: number): NodeRunView => ({
		node_id: id,
		kind: "package",
		status: "running",
		agent: "agent-a",
		outputs: null,
		error: null,
		attempts: Array.from({ length: attempts }, (_, i) => ({ attempt: i + 1 }) as AttemptView),
	});
	const chain = (id: string, name: string | null, nodes: NodeRunView[]): ChainRunView => ({
		id,
		chain_id: name === null ? "entry" : "sub",
		name,
		parent_chain_instance_id: name === null ? null : "main",
		async_node_id: name === null ? null : "spawn",
		depth: name === null ? 0 : 1,
		status: "running",
		params: {},
		started_at: "2026-01-01T00:00:00.000Z",
		ended_at: null,
		nodes,
	});
	const run: RunView = {
		...view("running"),
		chains: [
			chain("main", null, [node("fetch", 1), node("verify", 2)]),
			chain("sub-1", "回放", [node("probe", 1)]),
			chain("sub-2", "", [node("probe", 1)]),
		],
	};
	const origin = (chainInstanceId: string, subflow: string | null, nodeId: string, attempt = 1) =>
		logOrigin(run, {
			task_id: "t",
			chain_instance_id: chainInstanceId,
			subflow,
			node_id: nodeId,
			attempt,
		});

	it("主链省略子流程名，只有一次尝试的节点省略尝试序号", () => {
		expect(origin("main", null, "fetch")).toBe("fetch");
		expect(origin("main", null, "verify", 1)).toBe("verify #1");
		expect(origin("main", null, "verify", 2)).toBe("verify #2");
		expect(origin("sub-1", "回放", "probe")).toBe("回放 / probe");
		expect(origin("sub-2", "", "probe")).toBe("未命名子流程 / probe");
	});

	it("运行视图里还没有这次重试时，按这一行自己的尝试序号标出", () => {
		expect(origin("main", null, "fetch", 2)).toBe("fetch #2");
	});
});

describe("日志页签的节点范围（#224）", () => {
	const node = (id: string): NodeRunView => ({
		node_id: id,
		kind: "package",
		status: "running",
		agent: "agent-a",
		outputs: null,
		error: null,
		attempts: [],
	});
	const chain = (id: string, nodes: string[]): ChainRunView => ({
		id,
		chain_id: id,
		name: id === "main" ? null : id,
		parent_chain_instance_id: id === "main" ? null : "main",
		async_node_id: null,
		depth: id === "main" ? 0 : 1,
		status: "running",
		params: {},
		started_at: "2026-01-01T00:00:00.000Z",
		ended_at: null,
		nodes: nodes.map(node),
	});
	const run: RunView = {
		...view("running"),
		chains: [chain("main", ["fetch", "verify"]), chain("sub-1", ["probe", "verify"])],
	};

	it("没有节点筛选时是全部节点（不给范围）", () => {
		expect(logScope(run, null)).toBeUndefined();
	});

	it("筛选里勾选的节点，按链路实例和节点 ID 区分同名节点；平台自带图表和运行里没有的键不算", () => {
		expect(
			logScope(
				run,
				new Set(["sub-1:verify", "main:fetch", "platform", "sub-2:probe", "main:gone"]),
			),
		).toEqual([
			{ chain_instance_id: "main", node_id: "fetch" },
			{ chain_instance_id: "sub-1", node_id: "verify" },
		]);
	});

	it("清空筛选是没有任何节点，不是全部节点", () => {
		expect(logScope(run, new Set())).toEqual([]);
		expect(logScope(run, new Set(["platform"]))).toEqual([]);
	});
});

describe("运行视图与进度推送的合并（#110）", () => {
	const TASK = "00000000-0000-4000-8000-0000000000a1";
	const progress = (current: number, time: string): TaskProgressView => ({
		current,
		total: 100,
		message: `第 ${current} 步`,
		time,
		// Agent 时间不参与先后的判断：这里让它倒着走。
		agent_time: new Date(Date.UTC(2030, 0, 1) - current * 1000).toISOString(),
	});
	const withPing = (attemptProgress: AttemptView["progress"]): RunView => ({
		...view("running"),
		chains: [
			{
				id: "chain-main",
				chain_id: "entry",
				name: null,
				parent_chain_instance_id: null,
				async_node_id: null,
				depth: 0,
				status: "running",
				params: {},
				started_at: "2026-01-01T00:00:00.000Z",
				ended_at: null,
				nodes: [
					{
						node_id: "ping",
						kind: "package",
						status: "running",
						agent: "agent-a",
						outputs: null,
						error: null,
						attempts: [
							{
								task_id: TASK,
								attempt: 1,
								status: "running",
								agent: "agent-a",
								inputs: {},
								outputs: null,
								error: null,
								queued_at: "2026-01-01T00:00:00.000Z",
								started_at: "2026-01-01T00:00:00.000Z",
								ended_at: null,
								start_clock_offset: null,
								end_clock_offset: null,
								wake_at: null,
								progress: attemptProgress,
							},
						],
					},
				],
			},
		],
	});
	const pingProgress = (run: RunView) => run.chains[0]?.nodes[0]?.attempts[0]?.progress;
	const event = (p: TaskProgressView) => ({
		run_id: view("running").id,
		chain_instance_id: "chain-main",
		node_id: "ping",
		task_id: TASK,
		progress: p,
	});

	it("进度推送之前查询、之后才到达的运行视图不把进度改回旧值", () => {
		const pushed = progress(40, "2026-01-01T00:00:02.000Z");
		const cached = applyProgress(withPing(null), event(pushed));
		expect(pingProgress(latestRunView(cached, withPing(null)))).toEqual(pushed);
		const older = withPing(progress(10, "2026-01-01T00:00:01.000Z"));
		expect(pingProgress(latestRunView(cached, older))).toEqual(pushed);
	});

	it("运行视图里的进度更新时用它", () => {
		const cached = withPing(progress(40, "2026-01-01T00:00:02.000Z"));
		const newer = withPing(progress(60, "2026-01-01T00:00:03.000Z"));
		expect(latestRunView(cached, newer)).toBe(newer);
	});
});

describe("失败的运行：失败摘要、默认选中的节点、标签页标题", () => {
	const attempt = (n: number, status: AttemptView["status"], message?: string): AttemptView => ({
		task_id: `00000000-0000-4000-8000-00000000000${n}`,
		attempt: n,
		status,
		agent: "agent-a",
		inputs: {},
		outputs: null,
		error: message ? { kind: "node_error", message } : null,
		queued_at: "2026-01-01T00:00:00.000Z",
		started_at: "2026-01-01T00:00:00.000Z",
		ended_at: "2026-01-01T00:00:01.000Z",
		start_clock_offset: null,
		end_clock_offset: null,
		wake_at: null,
		progress: null,
	});
	const node = (id: string, status: NodeRunView["status"], attempts: AttemptView[] = []) =>
		({
			node_id: id,
			kind: "package",
			status,
			agent: "agent-a",
			outputs: null,
			error: attempts.at(-1)?.error ?? null,
			attempts,
		}) satisfies NodeRunView;
	const chain = (id: string, depth: number, nodes: NodeRunView[]): ChainRunView => ({
		id,
		chain_id: depth === 0 ? "entry" : "sub",
		name: depth === 0 ? null : "sub",
		parent_chain_instance_id: depth === 0 ? null : "main",
		async_node_id: depth === 0 ? null : "spawn",
		depth,
		status: "failed",
		params: {},
		started_at: depth === 0 ? "2026-01-01T00:00:00.000Z" : "2026-01-01T00:00:01.000Z",
		ended_at: "2026-01-01T00:00:05.000Z",
		nodes,
	});
	const failed: RunView = {
		...view("failed"),
		chains: [
			// 子流程实例排在主链后面：按层级顺序找第一个失败的节点。
			chain("child", 1, [node("probe", "failed", [attempt(1, "failed", "boom")])]),
			chain("main", 0, [
				node("fetch", "success", [attempt(1, "success")]),
				node("verify", "failed", [
					attempt(1, "failed", "AssertionError: 漏拦 3 笔"),
					attempt(2, "failed", "AssertionError: 仍然漏拦\n\nTraceback (most recent call last):"),
				]),
			]),
		],
	};

	it("第一个失败的节点、最后一次失败的尝试、错误信息的第一行（不含堆栈）", () => {
		expect(runFailure(failed)).toEqual({
			ref: { chainInstanceId: "main", nodeId: "verify" },
			nodeId: "verify",
			attempt: 2,
			message: "AssertionError: 仍然漏拦",
		});
	});

	it("失败摘要：节点、第几次尝试、错误信息的第一行；没有尝试记录或错误信息时省略", () => {
		const failure = runFailure(failed);
		if (!failure) throw new Error("没有失败");
		expect(failureSummary(failure)).toBe("失败于 verify（第 2 次）· AssertionError: 仍然漏拦");
		expect(failureSummary({ ...failure, attempt: null })).toBe(
			"失败于 verify · AssertionError: 仍然漏拦",
		);
		expect(failureSummary({ ...failure, message: "" })).toBe("失败于 verify（第 2 次）");
	});

	it("没有失败的节点时为 null", () => {
		expect(runFailure(view("success"))).toBeNull();
	});

	it("打开失败的运行默认选中第一个失败的节点；链接里给了节点时用链接里的", () => {
		expect(initialSelection(failed)).toEqual({ chainInstanceId: "main", nodeId: "verify" });
		expect(initialSelection(failed, "fetch")).toEqual({ chainInstanceId: "main", nodeId: "fetch" });
	});

	describe("下一个失败的节点（F）", () => {
		const ref = (chainInstanceId: string, nodeId: string) => ({ chainInstanceId, nodeId });
		const withTwoInMain: RunView = {
			...failed,
			chains: failed.chains.map((c) =>
				c.id === "main"
					? { ...c, nodes: [...c.nodes, node("report", "failed", [attempt(1, "failed", "boom")])] }
					: c,
			),
		};

		it("按链的层级与节点顺序依次取下一个，到末尾回到第一个", () => {
			expect(nextFailure(withTwoInMain, ref("main", "verify"))).toEqual(ref("main", "report"));
			expect(nextFailure(withTwoInMain, ref("main", "report"))).toEqual(ref("child", "probe"));
			expect(nextFailure(withTwoInMain, ref("child", "probe"))).toEqual(ref("main", "verify"));
		});

		it("没有选中、或选中的不是失败的节点时，从第一个失败的节点开始", () => {
			expect(nextFailure(withTwoInMain, null)).toEqual(ref("main", "verify"));
			expect(nextFailure(withTwoInMain, ref("main", "fetch"))).toEqual(ref("main", "verify"));
		});

		it("只有一个失败的节点时回到它自己；没有失败的节点时为 null", () => {
			const single: RunView = { ...failed, chains: failed.chains.filter((c) => c.id === "main") };
			expect(nextFailure(single, ref("main", "verify"))).toEqual(ref("main", "verify"));
			expect(nextFailure(view("success"), null)).toBeNull();
		});
	});

	describe("运行中的运行", () => {
		const running = (status: RunView["status"]): RunView => ({
			...view(status),
			chains: [
				chain("main", 0, [
					node("fetch", "success", [attempt(1, "success")]),
					node("load", "running", [{ ...attempt(1, "running"), ended_at: null }]),
					node("report", "pending"),
				]),
			],
		});

		it("没有链接节点也没有失败的节点：不默认选中，日志显示全部节点合并后的内容", () => {
			expect(initialSelection(running("running"))).toBeNull();
		});

		it("链接里的节点优先；运行里没有这个节点时当作没给", () => {
			expect(initialSelection(running("running"), "load")).toEqual({
				chainInstanceId: "main",
				nodeId: "load",
			});
			expect(initialSelection(running("running"), "不存在的节点")).toBeNull();
		});

		it("运行中已有失败的节点时选中它，而不是还在执行的节点", () => {
			const run = running("running");
			const [main] = run.chains;
			if (!main) throw new Error("没有主链");
			const withFailure: RunView = {
				...run,
				chains: [
					{
						...main,
						nodes: [...main.nodes, node("verify", "failed", [attempt(1, "failed", "boom")])],
					},
				],
			};
			expect(initialSelection(withFailure)).toEqual({ chainInstanceId: "main", nodeId: "verify" });
		});

		it("运行抽屉的摘要仍然回退到执行中的节点", () => {
			expect(focusNode(running("running"))).toEqual({ chainInstanceId: "main", nodeId: "load" });
		});
	});

	describe("节点的进度", () => {
		const progress = (current: number, total: number | null) => ({
			current,
			total,
			message: "",
			time: null,
			agent_time: null,
		});
		const withProgress = (...attempts: AttemptView[]) => node("noise", "running", attempts);

		it("有总数时是 current/total，总数未知时只有当前值", () => {
			expect(
				progressLabel(withProgress({ ...attempt(1, "running"), progress: progress(308, 3000) })),
			).toBe("308/3000");
			expect(
				progressLabel(withProgress({ ...attempt(1, "running"), progress: progress(12, null) })),
			).toBe("12");
		});

		it("没有进度的节点（没有尝试、没有上报）为 null", () => {
			expect(progressLabel(node("report", "pending"))).toBeNull();
			expect(progressLabel(withProgress(attempt(1, "running")))).toBeNull();
		});

		it("取最新一次尝试的进度，不沿用之前尝试的", () => {
			const retried = withProgress(
				{ ...attempt(1, "failed"), progress: progress(2999, 3000) },
				attempt(2, "running"),
			);
			expect(progressLabel(retried)).toBeNull();
			const resumed = withProgress(
				{ ...attempt(1, "failed"), progress: progress(2999, 3000) },
				{ ...attempt(2, "running"), progress: progress(5, 3000) },
			);
			expect(progressLabel(resumed)).toBe("5/3000");
		});

		it("节点结束后仍显示最后一次上报的进度", () => {
			const done = node("noise", "success", [
				{ ...attempt(1, "success"), progress: progress(3000, 3000) },
			]);
			expect(progressLabel(done)).toBe("3000/3000");
		});
	});

	it("标签页标题带运行状态与场景名", () => {
		expect(runDocumentTitle(view("running"), "日终数据处理")).toBe(
			"● 运行中 · 日终数据处理 · sfly",
		);
		expect(runDocumentTitle(view("failed"), "日终数据处理")).toBe("✕ 失败 · 日终数据处理 · sfly");
		expect(runDocumentTitle(view("success"), "日终数据处理")).toBe("✓ 成功 · 日终数据处理 · sfly");
		expect(runDocumentTitle(view("running", true), "日终数据处理")).toBe(
			"○ 取消中 · 日终数据处理 · sfly",
		);
	});
});
