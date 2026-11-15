import type { AttemptView, NodeRunView } from "@sfly/schema";
import { ListTreeIcon } from "lucide-react";
import { useMemo } from "react";
import { ActionTable } from "#/actions/ActionTable";
import { actionTable } from "#/actions/action-table";
import { useTaskActions } from "#/actions/use-task-actions";
import { EmptyState, ErrorState, TableSkeleton } from "#/components/feedback/states";
import { runNodeName } from "#/components/node-name";
import { MESSAGE, TERM } from "#/lib/copy";
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
				running: summary.running_complete ? undefined : "列满 50 个，可能还有没列出的",
				recent: summary.capped ? "超过上限后也一直更新" : undefined,
			},
		[summary],
	);
	if (!summary || !loaded) {
		return actions.error ? (
			<ErrorState
				title={MESSAGE.loadFailed(TERM.action)}
				error={actions.error}
				onRetry={actions.retry}
				className="my-4"
			/>
		) : (
			<TableSkeleton columns={5} rows={4} />
		);
	}
	if (actions.expired) return <Hint>这次运行的动作明细已超过保留期，已被清理。</Hint>;
	if (groups.length === 0) {
		return (
			<EmptyState
				icon={<ListTreeIcon />}
				title={`${runNodeName(node)} ${attempt.status === "running" ? "还没有" : "没有"}记录${TERM.action}`}
				description="标准节点这一轮不记录动作；节点的代码用 ctx.action 记录动作、ctx.mark 记录标记。"
				className="py-6"
			/>
		);
	}
	return (
		<div className="flex h-full flex-col">
			{actions.error && (
				<p role="alert" className="m-0 flex-none px-3 py-1 text-xs text-danger-fg">
					{MESSAGE.loadFailed(TERM.action)}：{actions.error.message}
				</p>
			)}
			<div className="min-h-0 flex-1">
				<ActionTable
					groups={groups}
					notes={notes || undefined}
					caption={`${runNodeName(node)} 的动作，按开始时间从新到旧`}
					day={day}
					hasOlder={actions.hasOlder}
					loadingOlder={actions.loadingOlder}
					loadOlder={actions.loadOlder}
				/>
			</div>
		</div>
	);
}
