import type { Readiness, SessionEvent } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	announcement,
	commitSummary,
	commitTotals,
	composerMode,
	hasModelProblem,
	lastTurnFlag,
	readinessItems,
	resultDisplayText,
	SESSION_STATUS,
	sessionStatusText,
	shortHash,
	statusWithQueue,
	steerDeliveryLabel,
	toolLine,
	toolResultSummary,
	toolRowTitle,
	turnEndText,
	turnEndTone,
	userRoleLabel,
} from "./session-text";
import {
	applyEvent,
	emptyTimeline,
	initialTimeline,
	prependHistory,
	type TimelineItem,
	type TimelineState,
	type ToolResultInfo,
} from "./timeline";

type TurnEnd = Extract<TimelineItem, { kind: "turn_end" }>;
const turnEnd = (over: Partial<TurnEnd> = {}): TurnEnd => ({
	kind: "turn_end",
	key: "e1",
	seq: 1,
	at: "2026-01-01T00:00:00.000Z",
	turn: 1,
	outcome: "completed",
	reason: "",
	steps: undefined,
	modelCalls: undefined,
	durationMs: 84_000,
	limitKind: undefined,
	errorClass: undefined,
	...over,
});

describe("会话页的文字", () => {
	it("工具调用那一行：命令写 $ 命令，读、写、编辑写读 / 写 / 改 路径", () => {
		expect(toolLine("command", "sfly package list")).toBe("$ sfly package list");
		expect(toolLine("read", "a.py")).toBe("读 a.py");
		expect(toolLine("write", "b.py")).toBe("写 b.py");
		expect(toolLine("edit", "c.py")).toBe("改 c.py");
		expect(toolLine(null, "")).toBe("工具");
	});

	it("工具结果的摘要：命令有退出码和用时；出错标出；被截断写明只显示了一部分（头尾和 pi 只留末尾两种都说得通）", () => {
		const base = { isError: false, text: "", truncated: false, durationMs: 420 };
		expect(toolResultSummary({ ...base, exitCode: 0 })).toBe("退出码 0 · 用时 420ms");
		expect(toolResultSummary({ ...base, exitCode: 2, isError: true })).toBe(
			"出错 · 退出码 2 · 用时 420ms",
		);
		expect(toolResultSummary(base)).toBe("用时 420ms");
		expect(toolResultSummary({ ...base, durationMs: 12_300, truncated: true })).toBe(
			"用时 12.3s · 输出太长，只显示了一部分",
		);
	});

	it("只有结果、没有对上的调用（翻页边界）：写明是哪一次调用的结果，能判断的写出是命令还是编辑，写明调用在更早的内容里", () => {
		const base = { isError: false, text: "", truncated: false, durationMs: 44 };
		const orphan = (result: ToolResultInfo) => ({ tool: null, title: "", result });
		// 命令的结果带退出码，编辑的结果带差异；读和写分不出来，写「工具调用」。
		expect(toolRowTitle(orphan({ ...base, exitCode: 0 }), true)).toBe(
			"命令的结果 · 更早的调用，加载更早的内容后显示",
		);
		expect(toolRowTitle(orphan({ ...base, diff: "-1 a\n+1 b" }), true)).toBe(
			"编辑的结果 · 更早的调用，加载更早的内容后显示",
		);
		expect(toolRowTitle(orphan(base), true)).toBe(
			"工具调用的结果 · 更早的调用，加载更早的内容后显示",
		);
		// 已经没有更早的内容了、调用还是没有：它没有记在时间线上，不再叫人去加载。
		expect(toolRowTitle(orphan({ ...base, exitCode: 1 }), false)).toBe(
			"命令的结果 · 这次调用没有记下",
		);
		// 有调用的行照旧：命令写 $、读写改写路径。
		expect(toolRowTitle({ tool: "command", title: "ls", result: base }, true)).toBe("$ ls");
	});

	it("结果正文的显示：只有命令的输出去颜色码、压空行；读、写、改文件的结果是文件的内容，显示原文（两个空行是文件自己的）", () => {
		const ESC = "\u001b";
		const base = { isError: false, truncated: false, durationMs: 5 };
		const file = "import os\n\n\ndef main():\n    pass\n";
		for (const tool of ["read", "write", "edit"] as const) {
			expect(resultDisplayText(tool, { ...base, text: file }), tool).toBe(file);
		}
		// 文件里恰好有颜色码：不当成终端的输出去掉（由不可信文字组件写成占位，如实反映文件）。
		expect(resultDisplayText("read", { ...base, text: `${ESC}[31mred${ESC}[0m` })).toBe(
			`${ESC}[31mred${ESC}[0m`,
		);
		// 命令：去颜色码，压空行。
		expect(
			resultDisplayText("command", {
				...base,
				text: `${ESC}[31mFAILED${ESC}[0m\n\n\nCommand exited with code 1`,
				exitCode: 1,
			}),
		).toBe("FAILED\n\nCommand exited with code 1");
		// 只有结果、没有对上的调用（翻页边界，`tool` 是 null）：有退出码的是命令，整理；没有的认不出是什么，显示原文。
		expect(resultDisplayText(null, { ...base, text: `a\n\n\nb`, exitCode: 0 })).toBe("a\n\nb");
		expect(resultDisplayText(null, { ...base, text: `a\n\n\nb` })).toBe("a\n\n\nb");
	});

	it("一轮结束：六种结局各一句", () => {
		expect(turnEndText(turnEnd({ steps: 12 }))).toBe("这一轮完成 · 12 步 · 用时 1m 24s");
		expect(turnEndText(turnEnd())).toBe("这一轮完成 · 用时 1m 24s");
		expect(turnEndText(turnEnd({ outcome: "stopped" }))).toBe("已停止");
		// 已停止不写原因：助手服务写的「用户停止了这一轮」不一定是用户点的（中止命令超时、补发的中止让它马上结束），不原样说成用户的操作。
		expect(turnEndText(turnEnd({ outcome: "stopped", reason: "用户停止了这一轮" }))).toBe("已停止");
		expect(turnEndText(turnEnd({ outcome: "stopped", reason: "会话结束了" }))).toBe("已停止");
		expect(turnEndText(turnEnd({ outcome: "interrupted", reason: "助手服务重启了" }))).toBe(
			"中断：助手服务重启了",
		);
		expect(turnEndText(turnEnd({ outcome: "model_unavailable", reason: "模型连不上" }))).toBe(
			"模型不可用：模型连不上。稍后说一句话可以接着做。",
		);
		expect(turnEndText(turnEnd({ outcome: "failed", reason: "出了点问题" }))).toBe(
			"出错：出了点问题",
		);
	});

	it("模型不可用：写明原因（类别和状态码）、这一轮做了几步、已经做的东西还在、怎么接着做（#548）", () => {
		expect(
			turnEndText(
				turnEnd({
					outcome: "model_unavailable",
					reason: "额度不足（402）",
					errorClass: "quota",
					steps: 7,
				}),
			),
		).toBe(
			"模型不可用：额度不足（402）。这一轮做了 7 步，都在上面；工作区的改动已经提交，已触发的运行不受影响。稍后说一句话可以接着做。",
		);
		// 一步也没做：不写「都在上面」，也不说有改动已经提交。
		expect(
			turnEndText(
				turnEnd({
					outcome: "model_unavailable",
					reason: "连不上模型端点",
					errorClass: "unreachable",
					steps: 0,
				}),
			),
		).toBe("模型不可用：连不上模型端点。这一轮没有做任何一步。稍后说一句话可以再试。");
	});

	it("上下文放不下（context_overflow）：整句换成「对话太长」，不论原因和步数", () => {
		const overflow = {
			outcome: "model_unavailable",
			reason: "对话太长，模型装不下（400）",
			errorClass: "context_overflow",
			steps: 12,
		} as const;
		expect(turnEndText(turnEnd(overflow))).toBe(
			"这次对话太长，模型装不下了。开一个新会话，工作区还在。",
		);
		expect(turnEndText(turnEnd({ ...overflow, steps: 0 }))).toBe(
			"这次对话太长，模型装不下了。开一个新会话，工作区还在。",
		);
		// 别的结局带着 context_overflow 也不换（只有「模型不可用」这一种结局才有类别的说法）。
		expect(
			turnEndText(
				turnEnd({ outcome: "failed", reason: "出了点问题", errorClass: "context_overflow" }),
			),
		).toBe("出错：出了点问题");
	});

	it("到了上限：按 limit_kind 写是哪一种，次数取事件里的，不写死也不看 reason 的文字", () => {
		expect(
			turnEndText(
				turnEnd({
					outcome: "limit",
					limitKind: "model_calls",
					modelCalls: 40,
					reason: "随便什么话",
				}),
			),
		).toBe("到了上限：40 次模型调用");
		expect(
			turnEndText(turnEnd({ outcome: "limit", limitKind: "model_calls", modelCalls: 25 })),
		).toBe("到了上限：25 次模型调用");
		expect(
			turnEndText(
				turnEnd({
					outcome: "limit",
					limitKind: "duration",
					durationMs: 1_200_000,
					reason: "40 次",
				}),
			),
		).toBe("到了上限：用时 20m 00s");
		expect(turnEndText(turnEnd({ outcome: "limit" }))).toBe("到了上限：模型调用次数");
	});

	it("一轮结束的语气：完成和停止中性，上限是提醒，其余是出了问题", () => {
		expect(turnEndTone("completed")).toBe("neutral");
		expect(turnEndTone("stopped")).toBe("neutral");
		expect(turnEndTone("limit")).toBe("warn");
		for (const outcome of ["interrupted", "model_unavailable", "failed"] as const) {
			expect(turnEndTone(outcome)).toBe("danger");
		}
	});

	it("会话的状态：空闲、在做、排队中、已结束", () => {
		expect(Object.entries(SESSION_STATUS).map(([k, v]) => [k, v.label])).toEqual([
			["idle", "空闲"],
			["running", "在做"],
			["queued", "排队中"],
			["ended", "已结束"],
		]);
	});

	it("就绪状态：逐条写缺什么和该找谁；工作台不在线时写出是哪一台；就绪时没有原因", () => {
		const offline: Readiness = {
			ready: false,
			workbench: "bench-1",
			problems: [{ kind: "workbench_offline", message: "工作台的 Agent 不在线" }],
		};
		expect(readinessItems(offline)).toEqual([
			{
				kind: "workbench_offline",
				what: "工作台 bench-1 不在线",
				hint: "请部署者检查工作台的 Agent 有没有在运行、能不能连上控制面",
			},
		]);
		const named: Readiness = {
			...offline,
			problems: [{ kind: "workbench_offline", message: "工作台 bench-1 不在线，等它连上" }],
		};
		expect(readinessItems(named).map((item) => item.what)).toEqual([
			"工作台 bench-1 不在线，等它连上",
		]);
		const none: Readiness = {
			ready: false,
			workbench: null,
			problems: [
				{ kind: "assistant_not_configured", message: "没有配置助手" },
				{ kind: "workbench_not_set", message: "没有设置工作台" },
			],
		};
		expect(readinessItems(none).map((item) => [item.what, item.hint])).toEqual([
			["没有配置助手", "请部署者在控制面上开启助手"],
			["没有设置工作台", "请部署者或项目管理员设置这个项目的工作台"],
		]);
		expect(readinessItems({ ready: true, workbench: "bench-1", problems: [] })).toEqual([]);
	});

	it("就绪状态里的每一种问题都写了该找谁（读不到就是漏了）", () => {
		const kinds = [
			"assistant_not_configured",
			"assistant_unreachable",
			"workbench_not_set",
			"workbench_offline",
			"model_not_configured",
			"model_unreachable",
		] as const;
		for (const kind of kinds) {
			const [item] = readinessItems({
				ready: false,
				workbench: null,
				problems: [{ kind, message: "x" }],
			});
			expect(item?.hint).toMatch(/^请/);
		}
		// 模型没有配置：要找部署者、在助手容器上配置（#551 的例子）。
		expect(
			readinessItems({
				ready: false,
				workbench: null,
				problems: [{ kind: "model_not_configured", message: "没有配置模型：缺少端点" }],
			})[0]?.hint,
		).toBe("请部署者在助手容器上配置模型");
	});

	it("会话列表上一轮的结局：完成和没有结束过的一轮不标；其余标出来，出了问题的醒目", () => {
		expect(lastTurnFlag(null)).toBeNull();
		expect(lastTurnFlag("completed")).toBeNull();
		expect(lastTurnFlag("interrupted")).toEqual({ label: "上一轮被打断", kind: "failed" });
		expect(lastTurnFlag("failed")).toEqual({ label: "上一轮出错", kind: "failed" });
		expect(lastTurnFlag("model_unavailable")).toEqual({
			label: "上一轮模型不可用",
			kind: "failed",
		});
		expect(lastTurnFlag("limit")).toEqual({ label: "上一轮到了上限", kind: "warn" });
		// 用户自己停的不是出了问题：中性的。
		expect(lastTurnFlag("stopped")).toEqual({ label: "上一轮已停止", kind: "stopped" });
	});
});

type UserItem = Extract<TimelineItem, { kind: "user" }>;
const userItem = (over: Partial<UserItem> = {}): UserItem => ({
	kind: "user",
	key: "e1",
	seq: 1,
	at: "2026-01-01T00:00:00.000Z",
	messageId: "5d1c0a7e-3b2f-4c68-9a41-000000000001",
	author: "alice",
	text: "好",
	role: "turn",
	delivery: null,
	droppedNote: null,
	queuedSeen: false,
	...over,
});
const WAITING_FOR = {
	session_id: "5d1c0a7e-3b2f-4c68-9a41-000000000009",
	title: "别的会话",
	created_by: "bob",
};
const modeOf = (
	status: TimelineState["status"],
	queue: TimelineState["queue"] = null,
	items: TimelineItem[] = [],
) => composerMode({ status, queue, items });

describe("会话页：输入框、标记、排位的文字", () => {
	it("输入框按会话的状态分：空闲接着说、在做是插话、排队中写排第几和在等谁、已结束没有输入框", () => {
		expect(modeOf("idle")).toEqual({ kind: "send" });
		expect(modeOf("running")).toEqual({ kind: "steer" });
		expect(modeOf("queued", { position: 2, waitingFor: WAITING_FOR })).toEqual({
			kind: "queued",
			position: 2,
			waitingFor: WAITING_FOR,
		});
		expect(modeOf("queued")).toEqual({ kind: "queued", position: null, waitingFor: null });
		expect(modeOf("ended")).toEqual({ kind: "ended" });
	});

	it("在做、却有话排在这一轮后面（停止途中说的）：不是插话，输入框不能再说", () => {
		expect(
			modeOf("running", { position: 1, waitingFor: WAITING_FOR }, [userItem({ role: "behind" })]),
		).toEqual({ kind: "behind", position: 1 });
		// 排着的话被撤掉了：又是插话。
		expect(modeOf("running", null, [userItem({ role: "cancelled" })])).toEqual({ kind: "steer" });
	});

	it("用户的话的标记：开一轮的话没有；插话、排在这一轮后面、已撤掉各一个", () => {
		expect(userRoleLabel("turn")).toBeNull();
		expect(userRoleLabel("steer")).toBe("插话");
		expect(userRoleLabel("behind")).toBe("排在这一轮后面");
		expect(userRoleLabel("cancelled")).toBe("已撤掉");
	});

	it("插话送到了没有：等待送达、已送到、没有送到；不知道（刷新后读到在做的一轮里的插话）和不是插话时不写", () => {
		expect(steerDeliveryLabel("waiting")).toBe("等待送达");
		expect(steerDeliveryLabel("delivered")).toBe("已送到");
		expect(steerDeliveryLabel("dropped")).toBe("没有送到");
		expect(steerDeliveryLabel("unknown")).toBeNull();
		expect(steerDeliveryLabel(null)).toBeNull();
	});

	it("状态那一格：排队中写排第几；别的状态不写", () => {
		expect(statusWithQueue("queued", 2)).toBe("排队中 · 排在第 2 位");
		expect(statusWithQueue("running", 1)).toBe("在做 · 排在第 1 位");
		expect(statusWithQueue("running", null)).toBe("在做");
		expect(sessionStatusText({ status: "queued", queue: { position: 3, waitingFor: null } })).toBe(
			"排队中 · 排在第 3 位",
		);
		expect(sessionStatusText({ status: "queued", queue: null })).toBe("排队中");
		expect(sessionStatusText({ status: "idle", queue: { position: 3, waitingFor: null } })).toBe(
			"空闲",
		);
	});
});

describe("一轮结束的那一行：结局原因里的换行", () => {
	it("中断、模型不可用、出错的原因有好几行：连续的空白压成一个空格，分隔行和播报里不出现换行", () => {
		const reason = "上游返回：\n第一行\n\n  第二行\t结尾  ";
		for (const outcome of ["interrupted", "model_unavailable", "failed"] as const) {
			const text = turnEndText(turnEnd({ outcome, reason }));
			expect(text).toContain("上游返回： 第一行 第二行 结尾");
			expect(text).not.toMatch(/[\n\t]/);
		}
	});

	it("别的看不见的字符不动（由不可信文字组件写出来）；没有换行的原因原样", () => {
		expect(turnEndText(turnEnd({ outcome: "failed", reason: "模型报错\u202e" }))).toContain(
			"\u202e",
		);
		expect(turnEndText(turnEnd({ outcome: "failed", reason: "模型报错" }))).toBe("出错：模型报错");
	});
});

describe("提交那一行的文字（#546）", () => {
	type Commit = Extract<TimelineItem, { kind: "commit" }>;
	const commit = (over: Partial<Commit> = {}): Commit => ({
		kind: "commit",
		key: "e1",
		seq: 1,
		at: "2026-01-01T00:00:00.000Z",
		turn: 2,
		leftover: false,
		beforeSession: false,
		hash: "3f1c2ab9d0e4a5b6c7d8e9f00112233445566778",
		files: [
			{ path: "a.py", additions: 12, deletions: 3 },
			{ path: "b.py", additions: 1, deletions: 0 },
			{ path: "logo.png", additions: null, deletions: null },
		],
		diff: "",
		truncated: false,
		...over,
	});

	it("「这一轮改了 N 个文件 +a −b」：文件数算上二进制文件，行数只算有行数的", () => {
		expect(commitSummary(commit())).toBe("这一轮改了 3 个文件 +13 −3");
		expect(commitTotals(commit().files)).toEqual({ files: 3, additions: 13, deletions: 3 });
		expect(
			commitSummary(commit({ files: [{ path: "x.bin", additions: null, deletions: null }] })),
		).toBe("这一轮改了 1 个文件 +0 −0");
	});

	it("上一轮被打断时留下的改动（补提交）写是第几轮留下的", () => {
		expect(commitSummary(commit({ leftover: true, turn: 1 }))).toBe(
			"第 1 轮被打断时留下的改动：3 个文件 +13 −3",
		);
	});

	it("会话开始之前工作区里就有的改动（第 1 轮开始前补提交的）写明是会话开始之前留下的", () => {
		expect(commitSummary(commit({ leftover: true, beforeSession: true, turn: 1 }))).toBe(
			"会话开始之前工作区里留下的改动：3 个文件 +13 −3",
		);
	});

	it("短提交号是前 7 位", () => {
		expect(shortHash(commit().hash)).toBe("3f1c2ab");
	});
});

describe("读屏的播报", () => {
	const ID = "a0000000-0000-4000-8000-00000000000a";
	const base = (n: number) => ({ seq: n, at: "2026-01-01T00:00:00.000Z" });
	const steer = (n: number): SessionEvent => ({
		type: "user_message",
		...base(n),
		message_id: ID,
		text: "先别改测试",
		steer: true,
		author: "alice",
		author_user_id: null,
	});
	const started = (n: number): SessionEvent => ({ type: "turn_started", ...base(n), turn: 1 });
	const step = (state: TimelineState, event: SessionEvent) => {
		const next = applyEvent(state, event);
		return { state: next, said: announcement(state, next) };
	};

	it("排到了：排队中变成在做播报一句；其余的状态变化不播", () => {
		const queued = initialTimeline("queued", [], false, { position: 1, waitingFor: null });
		const result = step(queued, started(1));
		expect(result.state.status).toBe("running");
		expect(result.said).toBe("轮到这个会话了，助手开始做");
		// 空闲的会话说话之后在做：没有排过队，不播「轮到了」。
		const idle = emptyTimeline("idle");
		expect(step(idle, started(1)).said).toBeNull();
	});

	it("插话没有送到：steer_dropped 对上那句话时播一句；同一句话的第二条通知不再播", () => {
		let state = emptyTimeline("running");
		state = applyEvent(applyEvent(state, started(1)), steer(2));
		const notice = (n: number): SessionEvent => ({
			type: "notice",
			...base(n),
			kind: "steer_dropped",
			message: "这句插话没有送到",
			message_id: ID,
		});
		const first = step(state, notice(3));
		expect(first.said).toBe("有一句插话没有送到，看时间线");
		expect(step(first.state, notice(4)).said).toBeNull();
	});

	it("会话被结束（可能是别人结束的）：写明是谁；一轮结束读结局那一句", () => {
		let state = emptyTimeline("running");
		state = applyEvent(state, started(1));
		const end: SessionEvent = {
			type: "turn_end",
			...base(2),
			turn: 1,
			outcome: "stopped",
			reason: "",
			duration_ms: 1000,
		};
		const ended = step(state, end);
		expect(ended.said).toBe("已停止");
		const byBob = step(ended.state, { type: "session_ended", ...base(3), by: "bob" });
		expect(byBob.state.status).toBe("ended");
		expect(byBob.said).toBe("这个会话已经结束（bob）");
	});

	it("往前翻页：读进来的更早的一页里有结局、没送到的插话，也不播（只看比之前最大序号更新的事件）", () => {
		// 审查的复现：在做的一轮在页面上，更早的一页（has_more）里有一轮的结局和一句没送到的插话。
		const state = initialTimeline("running", [started(51)], true);
		const older: SessionEvent[] = [
			{
				type: "user_message",
				...base(1),
				message_id: ID,
				text: "很早的话",
				steer: false,
				author: "alice",
				author_user_id: null,
			},
			started(2),
			steer(3),
			{ type: "notice", ...base(4), kind: "steer_dropped", message: "没有送到", message_id: ID },
			{
				type: "turn_end",
				...base(5),
				turn: 1,
				outcome: "completed",
				reason: "",
				duration_ms: 84_000,
			},
		];
		const turned = prependHistory(state, older, false);
		expect(turned.items.some((item) => item.kind === "turn_end")).toBe(true);
		expect(turned.items.some((item) => item.kind === "notice")).toBe(true);
		expect(announcement(state, turned)).toBeNull();
		// 翻到更早的几页也一样：每一页都不播。
		expect(announcement(turned, prependHistory(turned, [started(0)], false))).toBeNull();
	});

	it("一次到了好几条（重连之后补发，合成一次渲染）：播这一批的事实——插话没送到一句、最近的一个结局，不把过去几轮逐条念一遍", () => {
		let state = emptyTimeline("running");
		state = applyEvent(state, started(1));
		const turnEnd = (n: number, turn: number, outcome: "stopped" | "completed"): SessionEvent => ({
			type: "turn_end",
			...base(n),
			turn,
			outcome,
			reason: "",
			duration_ms: 1000,
		});
		let after = state;
		for (const event of [turnEnd(2, 1, "completed"), started(3), turnEnd(4, 2, "stopped")]) {
			after = applyEvent(after, event);
		}
		const said = announcement(state, after);
		expect(said).toBe(
			turnEndText(after.items.filter((item) => item.kind === "turn_end").at(-1) as never),
		);
		expect(said?.split("。")).toHaveLength(1);
	});

	it("打开页面时（前后是同一份状态）什么也不播", () => {
		const state = initialTimeline("running", [started(1), steer(2)], false);
		expect(announcement(state, state)).toBeNull();
	});
});

describe("就绪状态里有没有模型的问题（会话页据此不让空闲的会话说话）", () => {
	const readiness = (...kinds: Readiness["problems"][number]["kind"][]): Readiness => ({
		ready: kinds.length === 0,
		problems: kinds.map((kind) => ({ kind, message: "原因" })),
		workbench: "bench-1",
	});

	it("没有配置、连不上是模型的问题；助手、工作台的问题不算（助手页的就绪状态里写）", () => {
		expect(hasModelProblem(readiness())).toBe(false);
		expect(hasModelProblem(readiness("model_not_configured"))).toBe(true);
		expect(hasModelProblem(readiness("model_unreachable"))).toBe(true);
		expect(hasModelProblem(readiness("workbench_offline", "model_unreachable"))).toBe(true);
		expect(
			hasModelProblem(
				readiness("assistant_not_configured", "assistant_unreachable", "workbench_not_set"),
			),
		).toBe(false);
	});
});
