import type { AttemptView, NodeRunView } from "@sfly/schema";
import { ListTreeIcon } from "lucide-react";
import { useMemo } from "react";
import { ActionTable } from "#/actions/ActionTable";
import { actionTable } from "#/actions/action-table";
import { useTaskActions } from "#/actions/use-task-actions";
import { EmptyState } from "#/components/feedback/states";
import { runNodeName } from "#/components/node-name";
import { NODE_ACTIONS } from "#/lib/copy";
import { Hint } from "./Hint";

/**
 * 底部面板的「动作」页签（规格 #345，原型 `actPanel`）：选中节点的那一次尝试的动作，分成「正在做」「最近 20 个」
 * 「更早的明细」三组（action-table.ts），往下滚动读更早的明细，推送来的插到它的位置。没有动作的节点写明
 * 标准节点这一轮不记录动作。
 */
export function ActionsTab({
	node,
	attempt,
	day,
}: {
	node: NodeRunView;
	attempt: AttemptView;
	/** 运行开始的时刻：时间要不要带日期按它那一天判断。 */
	day: string;
}) {
	const actions = useTaskActions(attempt.task_id);
	const { summary, details, countOnly, loaded } = actions;
	const groups = useMemo(
		() =>
			summary && loaded
				? actionTable({ summary, details, countOnly, endedAt: attempt.ended_at })
				: [],
		[summary, loaded, details, countOnly, attempt.ended_at],
	);
	const notes = useMemo(
		() =>
			summary && {
				running: summary.running_complete ? undefined : NODE_ACTIONS.runningIncomplete,
				recent: summary.capped ? NODE_ACTIONS.recentWhenCapped : undefined,
			},
		[summary],
	);
	const error = actions.error && (
		<p role="alert" className="m-0 flex-none px-3 py-1 text-xs text-danger-fg">
			{NODE_ACTIONS.loadFailed}
			{actions.error}
		</p>
	);

	if (!summary || !loaded) return error || <Hint>{NODE_ACTIONS.loading}</Hint>;
	if (actions.expired) return <Hint>{NODE_ACTIONS.expired}</Hint>;
	if (groups.length === 0) {
		return (
			<EmptyState
				icon={<ListTreeIcon />}
				title={NODE_ACTIONS.none(runNodeName(node), attempt.status === "running")}
				description={NODE_ACTIONS.noneHint}
				className="py-6"
			/>
		);
	}
	return (
		<div className="flex h-full flex-col">
			{error}
			<div className="min-h-0 flex-1">
				<ActionTable
					groups={groups}
					notes={notes || undefined}
					caption={NODE_ACTIONS.caption(runNodeName(node))}
					day={day}
					hasOlder={actions.hasOlder}
					loadingOlder={actions.loadingOlder}
					loadOlder={actions.loadOlder}
				/>
			</div>
		</div>
	);
}
