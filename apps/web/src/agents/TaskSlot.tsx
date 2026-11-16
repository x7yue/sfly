import type { RunningTaskView } from "@sfly/schema";
import type { CurrentActivity } from "#/actions/current-activity";
import { Elapsed } from "#/components/elapsed";
import { SlotCell } from "#/components/slot-cell";
import { FocusRows } from "#/focus/FocusRows";
import { MESSAGE, NODE_ACTIONS, TERM } from "#/lib/copy";
import { Truncate } from "@/components/ui/truncate";
import { slotContent } from "./slot-content";
import type { RunFocusRead } from "./use-slot-focus";

/**
 * Agent 管理页的槽位格（原型 #agents）：`SlotCell` 加上这个任务此刻在做什么（`正在 保持 4 小时 · 1h 43m`，没有动作时是
 * 进度的说明）和它的前两个关注项（有异常的排前，带三角和原因，多出的写「还有 N 个关注项」；场景没设关注项时是主指标，
 * 写明原因）。格子的可访问名称写出节点、场景、正在做的动作和有异常的关注项。
 * `runFocus` 是这个任务所属运行的读数，由页面按运行读好再分过来（`useSlotFocus`）。
 */
export function TaskSlot({
	task,
	runFocus,
}: {
	task: RunningTaskView;
	runFocus: RunFocusRead | undefined;
}) {
	const content = slotContent(task, runFocus?.data);
	return (
		<SlotCell task={task} summary={content.summary}>
			{content.activity && <ActivityRow activity={content.activity} />}
			{content.focus ? (
				<FocusRows
					variant="slot"
					preview={content.focus}
					generatedAt={content.focus.generatedAt}
					mode={content.focus.mode}
					aria-label={`这个任务的${content.focus.mode === "primary" ? TERM.primaryMetric : TERM.focusItem}`}
					className="mt-2 gap-0.5 border-t border-border-soft pt-2"
				/>
			) : (
				runFocus?.failed && (
					<p className="m-0 mt-2 text-xs text-fg-3">{MESSAGE.loadFailed(TERM.focusItem)}</p>
				)
			)}
		</SlotCell>
	);
}

/**
 * 「正在」那一行：动作的名称和已持续多久（按控制面时间每秒走一次）；没有动作时只写进度的说明，没有时长。
 * 读屏用户在格子的可访问名称里读到「正在做 X」，这一行不再单独播报。
 */
function ActivityRow({ activity }: { activity: CurrentActivity }) {
	return (
		<div
			data-testid="slot-activity"
			className="mt-2 flex min-w-0 items-center gap-1.5 rounded-md bg-sunk px-2 py-0.75 text-xs"
		>
			{activity.kind === "action" ? (
				<>
					<span className="flex-none text-fg-3">{NODE_ACTIONS.doingNow}</span>
					<Truncate className="text-fg-1">{activity.name}</Truncate>
					<Elapsed
						since={activity.startedAt}
						className="ml-auto flex-none pl-1.5 font-mono text-fg-3"
					/>
				</>
			) : (
				<Truncate className="text-fg-1">{activity.message}</Truncate>
			)}
		</div>
	);
}
