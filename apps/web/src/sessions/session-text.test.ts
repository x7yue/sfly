import type { Readiness } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	readinessProblems,
	SESSION_STATUS,
	toolLine,
	toolResultSummary,
	turnEndText,
	turnEndTone,
} from "./session-text";
import type { TimelineItem } from "./timeline";

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

	it("工具结果的摘要：命令有退出码和用时；出错标出；被截断写明只显示了头尾", () => {
		const base = { isError: false, text: "", truncated: false, durationMs: 420 };
		expect(toolResultSummary("command", { ...base, exitCode: 0 })).toBe("退出码 0 · 用时 420ms");
		expect(toolResultSummary("command", { ...base, exitCode: 2, isError: true })).toBe(
			"出错 · 退出码 2 · 用时 420ms",
		);
		expect(toolResultSummary("command", base)).toBe("用时 420ms");
		expect(toolResultSummary("edit", { ...base, durationMs: 12_300, truncated: true })).toBe(
			"用时 12.3s · 输出太长，只显示了头尾",
		);
	});

	it("一轮结束：六种结局各一句", () => {
		expect(turnEndText(turnEnd({ steps: 12 }))).toBe("这一轮完成 · 12 步 · 用时 1m 24s");
		expect(turnEndText(turnEnd())).toBe("这一轮完成 · 用时 1m 24s");
		expect(turnEndText(turnEnd({ outcome: "stopped" }))).toBe("已停止");
		expect(turnEndText(turnEnd({ outcome: "interrupted", reason: "助手服务重启了" }))).toBe(
			"中断：助手服务重启了",
		);
		expect(turnEndText(turnEnd({ outcome: "model_unavailable", reason: "模型连不上" }))).toBe(
			"模型不可用：模型连不上",
		);
		expect(turnEndText(turnEnd({ outcome: "failed", reason: "出了点问题" }))).toBe(
			"出错：出了点问题",
		);
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

	it("就绪状态：逐条写缺什么；工作台不在线时写出是哪一台；就绪时没有原因", () => {
		const offline: Readiness = {
			ready: false,
			workbench: "bench-1",
			problems: [{ kind: "workbench_offline", message: "工作台的 Agent 不在线" }],
		};
		expect(readinessProblems(offline)).toEqual(["工作台 bench-1 不在线"]);
		const named: Readiness = {
			...offline,
			problems: [{ kind: "workbench_offline", message: "工作台 bench-1 不在线，等它连上" }],
		};
		expect(readinessProblems(named)).toEqual(["工作台 bench-1 不在线，等它连上"]);
		const none: Readiness = {
			ready: false,
			workbench: null,
			problems: [
				{ kind: "assistant_not_configured", message: "没有配置助手" },
				{ kind: "workbench_not_set", message: "没有设置工作台" },
			],
		};
		expect(readinessProblems(none)).toEqual(["没有配置助手", "没有设置工作台"]);
	});
});
