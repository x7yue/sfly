import type { RunningTaskView } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { activityLabel, currentActivity } from "./current-activity";

const progress = (message: string) => ({
	current: 3,
	total: 10,
	message,
	time: "2026-01-01T00:00:01.000Z",
	agent_time: "2026-01-01T00:00:01.000Z",
});
const hold = { name: "保持 4 小时", started_at: "2026-01-01T00:00:00.000Z" };

describe("此刻在做什么", () => {
	it("有正在做的动作时取动作，进度的说明让位", () => {
		const activity = currentActivity({
			status: "running",
			current_action: hold,
			progress: progress("第 3 批"),
		});
		expect(activity).toEqual({
			kind: "action",
			name: "保持 4 小时",
			startedAt: Date.parse(hold.started_at),
		});
		expect(activity && activityLabel(activity)).toBe("正在做 保持 4 小时");
	});

	it("没有动作时取进度的说明；说明为空、也没有进度时什么都不写", () => {
		const activity = currentActivity({
			status: "running",
			current_action: null,
			progress: progress("第 3 批"),
		});
		expect(activity).toEqual({ kind: "progress", message: "第 3 批" });
		expect(activity && activityLabel(activity)).toBe("正在做 第 3 批");
		expect(
			currentActivity({ status: "running", current_action: null, progress: progress(" ") }),
		).toBe(null);
		expect(currentActivity({ status: "running", current_action: null, progress: null })).toBe(null);
	});

	it("不在执行中的尝试没有「正在做」：结束后留下的进度不算", () => {
		for (const status of ["dispatched", "success", "failed", "cancelled"] as const) {
			expect(
				currentActivity({ status, current_action: null, progress: progress("第 10 批") }),
			).toBe(null);
		}
		expect(currentActivity(undefined)).toBe(null);
	});

	it("Agent 列表里的任务（RunningTaskView）按同一条规则取：执行中才有，准备中没有", () => {
		const task = (
			status: RunningTaskView["status"],
		): Pick<RunningTaskView, "status" | "current_action" | "progress"> => ({
			status,
			current_action: hold,
			progress: progress("第 3 批"),
		});
		expect(currentActivity(task("running"))).toEqual({
			kind: "action",
			name: "保持 4 小时",
			startedAt: Date.parse(hold.started_at),
		});
		expect(currentActivity(task("dispatched"))).toBe(null);
	});
});
