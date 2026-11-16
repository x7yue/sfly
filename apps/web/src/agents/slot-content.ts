import type { RunFocus, RunFocusItem, RunningTaskView } from "@sfly/schema";
import { activityLabel, type CurrentActivity, currentActivity } from "#/actions/current-activity";
import { anomalyText } from "#/focus/focus-format";
import { focusPreview } from "#/focus/focus-preview";
import { FOCUS, TERM } from "#/lib/copy";

/** 槽位格里这个任务的关注项：前两项（读数里有异常的在最前）和没显示的个数。 */
export interface SlotFocus {
	/** `primary`：场景没有设置关注项，显示的是这个节点的主指标。 */
	mode: RunFocus["mode"];
	shown: RunFocusItem[];
	more: number;
	/** 这份读数的生成时间（控制面时间）：「多久前」「已无新数据多久」按它算。 */
	generatedAt: string;
}

export interface SlotContent {
	activity: CurrentActivity | null;
	focus: SlotFocus | null;
	/** 补进格子可访问名称的说明（正在做什么、哪些关注项有异常）；没有内容时为 undefined。 */
	summary: string | undefined;
}

/** 一项关注项在槽位格里的名称：主指标前面写明是主指标（关注项的名称是作者起的或图表标题，没有这个问题）。 */
export const slotItemTitle = (item: Pick<RunFocusItem, "title">, mode: RunFocus["mode"]): string =>
	mode === "primary" ? `${TERM.primaryMetric} ${item.title}` : item.title;

/**
 * 一个被占用的槽位里要写的内容：正在做什么（`currentActivity`，和节点卡片同一条规则）和这个任务的关注项。
 * 关注项取运行的读数（`GET /runs/:id/focus`）里来源正是这个任务的那些：同一个运行里别的任务的项、同一个节点在别的
 * 链实例里的项不算。读数还没到时只有「正在做」。
 */
export function slotContent(task: RunningTaskView, focus: RunFocus | undefined): SlotContent {
	const activity = currentActivity(task);
	const mine = focus?.items.filter((item) => item.source.task_id === task.task_id) ?? [];
	const reasons = focus
		? mine.flatMap((item) => {
				const reason = anomalyText(item, focus.generated_at);
				return reason === null ? [] : [`${slotItemTitle(item, focus.mode)} ${reason}`];
			})
		: [];
	const parts = [
		...(activity ? [activityLabel(activity)] : []),
		...(reasons.length > 0
			? [`${FOCUS.attentionCount(reasons.length)}：${reasons.join("；")}`]
			: []),
	];
	const { shown, more } = focusPreview(mine);
	return {
		activity,
		focus:
			focus && mine.length > 0
				? { mode: focus.mode, shown, more, generatedAt: focus.generated_at }
				: null,
		summary: parts.length > 0 ? parts.join("，") : undefined,
	};
}
