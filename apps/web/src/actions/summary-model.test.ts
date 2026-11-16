import type { AttemptView, NodeRunView, RunningActionView } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { actionAttempt, runningRows } from "./summary-model";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const running = (
	id: number,
	parent: number | null,
	depth: number,
	name: string,
	startedMs: number,
): RunningActionView => ({
	id,
	parent,
	depth,
	name,
	fields: {},
	started_at: new Date(T0 + startedMs).toISOString(),
	agent_started_at: new Date(T0 + startedMs).toISOString(),
});
const shown = (rows: ReturnType<typeof runningRows>) =>
	rows.map((row) => `${row.level}:${row.action.name}`);

describe("正在做的动作排成树", () => {
	it("子动作紧跟在父动作下面，同一层按开始的先后排，不按 ID", () => {
		const rows = runningRows([
			running(1, null, 0, "保持", 100),
			running(2, 1, 1, "下单 B", 400),
			running(3, null, 0, "预热", 50),
			running(4, 1, 1, "下单 A", 300),
			running(5, 4, 2, "回报", 350),
		]);
		expect(shown(rows)).toEqual(["0:预热", "0:保持", "1:下单 A", "2:回报", "1:下单 B"]);
	});

	it("最多缩进 3 层（和「动作」页一样），更深的画在第 3 层", () => {
		const rows = runningRows([
			running(1, null, 0, "a", 1),
			running(2, 1, 1, "b", 2),
			running(3, 2, 2, "c", 3),
			running(4, 3, 3, "d", 4),
			running(5, 4, 4, "e", 5),
		]);
		expect(shown(rows)).toEqual(["0:a", "1:b", "2:c", "3:d", "3:e"]);
	});

	it("父动作不在列表里（已经结束，或列满 50 个被挤掉）时，从它自己的层级起排", () => {
		const rows = runningRows([running(7, 3, 1, "下单", 10), running(1, null, 0, "保持", 5)]);
		expect(shown(rows)).toEqual(["0:保持", "1:下单"]);
	});

	it("父子关系成环（被改过的 SDK）也不丢动作", () => {
		const rows = runningRows([running(1, 2, 1, "甲", 1), running(2, 1, 1, "乙", 2)]);
		expect(shown(rows).sort()).toEqual(["1:乙", "1:甲"]);
	});
});

const attempt = (n: number, status: AttemptView["status"], started: boolean): AttemptView =>
	({
		task_id: `t${n}`,
		attempt: n,
		status,
		started_at: started ? "2026-01-01T00:00:00.000Z" : null,
	}) as AttemptView;
const node = (kind: NodeRunView["kind"], attempts: AttemptView[]) => ({ kind, attempts });

describe("检查器的动作属于哪一次尝试", () => {
	it("取最近一次开始执行的尝试：执行中、结束的（成功、失败、已取消、已停止）都有", () => {
		for (const status of ["running", "success", "failed", "cancelled", "stopped"] as const) {
			expect(actionAttempt(node("package", [attempt(1, status, true)]))?.task_id).toBe("t1");
		}
	});

	it("重试的新尝试还在排队或准备时，是上一次的；新尝试开始以后是新的", () => {
		const failed = attempt(1, "failed", true);
		expect(actionAttempt(node("package", [failed, attempt(2, "queued", false)]))?.task_id).toBe(
			"t1",
		);
		expect(actionAttempt(node("package", [failed, attempt(2, "dispatched", false)]))?.task_id).toBe(
			"t1",
		);
		expect(actionAttempt(node("package", [failed, attempt(2, "running", true)]))?.task_id).toBe(
			"t2",
		);
	});

	it("没有开始执行过的节点没有：没有尝试（待执行、子流程还没触发、已跳过）、排队中、准备中、没开始就被取消", () => {
		expect(actionAttempt(undefined)).toBeUndefined();
		expect(actionAttempt(node("package", []))).toBeUndefined();
		for (const status of ["queued", "dispatched", "cancelled", "skipped"] as const) {
			expect(actionAttempt(node("package", [attempt(1, status, false)]))).toBeUndefined();
		}
	});

	it("不在 Agent 上执行的内置节点没有，等待中的定时和 Sleep 节点也是", () => {
		for (const kind of [
			"timer",
			"sleep",
			"async",
			"stop_subflow",
			"feishu_notify",
			"entry",
		] as const) {
			expect(actionAttempt(node(kind, [attempt(1, "waiting", true)]))).toBeUndefined();
		}
	});
});
