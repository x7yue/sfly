import type { AttemptView, NodeRunView } from "@sfly/schema";
import { ListTreeIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { ActionTable } from "#/actions/ActionTable";
import { ActionToolbar } from "#/actions/ActionToolbar";
import { type ActionFilter, NO_FILTER } from "#/actions/action-details";
import { filterAnnouncement, isFiltered, withFailed } from "#/actions/action-filter";
import { type ActionTableGroup, actionTable, groupNotes } from "#/actions/action-table";
import { useTaskActions } from "#/actions/use-task-actions";
import { EmptyState, ErrorState, TableSkeleton } from "#/components/feedback/states";
import { runNodeName } from "#/components/node-name";
import { ACTION, ACTION_PAGE, MESSAGE, TERM } from "#/lib/copy";
import { Button } from "@/components/ui/button";
import { attemptClockNote } from "./attempt-clock";
import { Hint } from "./Hint";
import { setActionTimeKind, useActionTimeKind } from "./log-time-kind";

/**
 * 底部面板的「动作」页签（规格 #345，原型 `actPanel`）：选中节点的那一次尝试的动作，分成「正在做」「最近 20 个」
 * 「更早的明细」三组（action-table.ts），往下滚动读更早的明细，推送来的插到它的位置。没有动作的节点写明
 * 标准节点目前不记录动作。
 *
 * 工具条（ActionToolbar）按名称、只看失败筛选，表格里的时间可以切成 Agent 时间（表头写明时钟偏差，时间线始终按控制面时间画）；
 * 点一行的开始时间，日志跳到那一刻（`onLocate`）。筛选条件由底部面板持有：切到日志再回来还在。
 *
 * 换筛选条件要重新读明细，工具条一直留着，焦点不丢：读到之前表格还显示上一个条件的行（变淡），第一次读到之前才是骨架。
 * 筛选之后在实时区域（`<output>`）播报结果，在点的那一刻算一次（见 `filterAnnouncement`）。
 * 筛选后没有行时写明并给出「清除筛选」，点它以后焦点回到名称下拉；只计数那一行里的「只看失败」被换掉以后，
 * 焦点回到工具条的「只看失败」。
 */
export function ActionsTab({
	node,
	attempt,
	day,
	filter,
	onFilter,
	onLocate,
}: {
	node: NodeRunView;
	attempt: AttemptView;
	/** 运行开始的时刻：时间要不要带日期按它那一天判断。 */
	day: string;
	filter: ActionFilter;
	onFilter: (filter: ActionFilter) => void;
	/** 点一行的开始时间：日志跳到那一刻（控制面时间，毫秒）。 */
	onLocate: (at: number) => void;
}) {
	const timeKind = useActionTimeKind();
	const actions = useTaskActions(attempt.task_id, filter);
	const { summary, details, controlPlanePeriods, hasOlder, loaded } = actions;
	const groups = useMemo(
		() =>
			summary && loaded
				? actionTable({
						summary,
						details,
						controlPlanePeriods,
						hasOlder,
						endedAt: attempt.ended_at,
						filter,
					})
				: [],
		[summary, loaded, details, controlPlanePeriods, hasOlder, attempt.ended_at, filter],
	);

	// 第一次读到以后，换筛选条件重新读时工具条不再换成骨架：焦点在工具条上，不能丢。
	const [opened, setOpened] = useState(false);
	if (loaded && !opened) setOpened(true);
	// 表格显示的是最近一次读到的行、它们的筛选条件和说明：新条件的明细读到之前，不让上一批行带着新条件的组名和说明。
	const notes = useMemo(
		() =>
			summary && loaded
				? groupNotes({ summary, controlPlanePeriods, hasOlder, failedOnly: filter.failed === true })
				: undefined,
		[summary, loaded, controlPlanePeriods, hasOlder, filter.failed],
	);
	const shown = useRef({ groups: [] as ActionTableGroup[], filter, notes });
	if (loaded) shown.current = { groups, filter, notes };
	const shownFilter = shown.current.filter;
	const clockNote = useMemo(() => attemptClockNote(attempt), [attempt]);

	const [announcement, setAnnouncement] = useState({ text: "", count: 0 });
	const nameSelect = useRef<HTMLSelectElement>(null);
	const failedToggle = useRef<HTMLButtonElement>(null);

	const change = (next: ActionFilter) => {
		onFilter(next);
		// 和上一次播报的话相同时读屏不读：交替加句号，让文字变一下。
		if (summary) {
			setAnnouncement(({ count }) => ({
				text: `${filterAnnouncement(summary, next)}${count % 2 === 0 ? "" : "。"}`,
				count: count + 1,
			}));
		}
	};

	if (!summary || !opened) {
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
	if (loaded && groups.length === 0 && !isFiltered(filter)) {
		return (
			<EmptyState
				icon={<ListTreeIcon />}
				title={`${runNodeName(node)} ${attempt.status === "running" ? "还没有" : "没有"}记录${TERM.action}`}
				description="标准节点目前不记录动作；节点的代码用 ctx.action 记录动作、ctx.mark 记录标记。"
				className="py-6"
			/>
		);
	}
	return (
		<div className="flex h-full flex-col">
			<ActionToolbar
				summary={summary}
				filter={filter}
				onFilter={change}
				timeKind={timeKind}
				onTimeKind={setActionTimeKind}
				nameSelect={nameSelect}
				failedToggle={failedToggle}
			/>
			<output className="sr-only">{announcement.text}</output>
			{loaded && actions.error && (
				<p role="alert" className="m-0 flex-none px-3 py-1 text-xs text-danger-fg">
					{MESSAGE.loadFailed(TERM.action)}：{actions.error.message}
				</p>
			)}
			<div className="min-h-0 flex-1">
				{!loaded && actions.error ? (
					<ErrorState
						title={MESSAGE.loadFailed(TERM.action)}
						error={actions.error}
						onRetry={actions.retry}
						className="my-4"
					/>
				) : loaded && groups.length === 0 ? (
					<div className="flex items-center gap-3 p-4 text-sm text-fg-3">
						<p className="m-0">{ACTION_PAGE.none}</p>
						<Button
							size="sm"
							onClick={() => {
								change(NO_FILTER);
								nameSelect.current?.focus();
							}}
						>
							{ACTION.clearFilters}
						</Button>
					</div>
				) : !loaded && shown.current.groups.length === 0 ? (
					<TableSkeleton columns={5} rows={4} />
				) : (
					<ActionTable
						// 换了筛选条件是另一批行：从头看起，不停在上一批滚到的位置。
						key={`${shownFilter.name ?? ""}\n${shownFilter.failed === true}`}
						groups={shown.current.groups}
						notes={shown.current.notes}
						caption={`${runNodeName(node)} 的动作，按开始时间从新到旧`}
						day={day}
						timeKind={timeKind}
						clockNote={clockNote}
						failedOnly={shownFilter.failed === true}
						onLocate={onLocate}
						onFailedOnly={() => {
							change(withFailed(filter, true));
							failedToggle.current?.focus();
						}}
						hasOlder={actions.hasOlder}
						loadingOlder={actions.loadingOlder}
						loadOlder={actions.loadOlder}
						busy={!loaded}
					/>
				)}
			</div>
		</div>
	);
}
