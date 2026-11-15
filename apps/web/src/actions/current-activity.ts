import type { AttemptView } from "@sfly/schema";

/**
 * 执行中的任务此刻在做什么（规格 #345 故事 29）：有正在做的动作时是动作（控制面选出的最外层、开始得最早的那个，
 * 即 `current_action`），没有动作时是进度的说明。节点卡片、检查器、Agent 槽位格、运行监控「概览」显示「正在做」的
 * 地方都按这一条规则取，不另写。
 */
export type CurrentActivity =
	| { kind: "action"; name: string /** 开始的控制面时间（毫秒）。 */; startedAt: number }
	| { kind: "progress"; message: string };

/**
 * 这次尝试此刻在做什么；不在执行中、或者既没有动作也没有进度的说明时为 null。
 * 运行视图里的尝试（`AttemptView`）和 Agent 列表里的任务（`RunningTaskView`）都是这个形状，两处按同一条规则取。
 */
export function currentActivity(
	attempt: Pick<AttemptView, "status" | "current_action" | "progress"> | undefined,
): CurrentActivity | null {
	if (attempt?.status !== "running") return null;
	const action = attempt.current_action;
	if (action)
		return { kind: "action", name: action.name, startedAt: Date.parse(action.started_at) };
	const message = attempt.progress?.message.trim();
	return message ? { kind: "progress", message } : null;
}

/** 读屏用的一句话：「正在做 保持 4 小时」；没有动作时是进度的说明。不带已持续多久（每秒都在变）。 */
export const activityLabel = (activity: CurrentActivity): string =>
	`正在做 ${activity.kind === "action" ? activity.name : activity.message}`;
