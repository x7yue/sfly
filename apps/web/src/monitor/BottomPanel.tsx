import { nameBeforeId } from "@sfly/orchestration";
import {
	type AttemptView,
	artifactsApi,
	LOG_LEVELS,
	type LogLineView,
	type NodeRunView,
	type RunLogLine,
	type RunView,
	runsApi,
	type StoredOrchestrationDocument,
} from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { DownloadIcon, XIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ActionFilter, NO_FILTER } from "#/actions/action-details";
import { actionCount } from "#/actions/action-table";
import { useActionSummary } from "#/actions/use-task-actions";
import { ErrorMessage } from "#/components/feedback/error-message";
import { NodeName, runNodeName } from "#/components/node-name";
import { ResizeHandle } from "#/components/ResizeHandle";
import { useShortcut } from "#/components/shortcuts";
import { nodeStatusView, StatusPill } from "#/components/status";
import { UntrustedText } from "#/components/untrusted-text";
import { apiQuery, apiUrl } from "#/lib/api";
import {
	ACTION,
	attemptLabel,
	ERROR_LOCATION_LABEL,
	LOG_LEVEL_LABEL,
	MESSAGE,
	TERM,
} from "#/lib/copy";
import {
	formatBytes,
	formatClock,
	formatDuration,
	formatFullDateTime,
	formatInteger,
	formatMetric,
	TIME_NOT_RECORDED,
} from "#/lib/format";
import { INLINE_LINK } from "#/lib/inline-link";
import { NODE_STATUS } from "#/lib/node-status";
import { STATUS_POLL_MS } from "#/lib/polling";
import { shortcutText } from "#/lib/shortcuts";
import { untrustedPlain } from "#/lib/untrusted-text";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Truncate } from "@/components/ui/truncate";
import { ActionsTab } from "./ActionsTab";
import { attemptAgentTimes } from "./attempt-clock";
import { CHARTS_MIN_HEIGHT } from "./ChartWorkspace";
import { PANEL_FLOOR } from "./detail-layout";
import { Hint } from "./Hint";
import { LogList, type LogPaging, type LogReveal } from "./LogList";
import { LOG_TIME_KINDS, type LogTimeKind, setLogTimeKind, useLogTimeKind } from "./log-time-kind";
import { type LogMoment, panelOpen, readsLogs } from "./monitor-scope";
import {
	PLATFORM_KEY,
	useMonitor,
	useMonitorActions,
	useScope,
	useTimeAxis,
} from "./monitor-state";
import { type NodeRef, nodeKey } from "./node-ref";
import { QueueWaitNote } from "./QueueWaitNote";
import type { PanelTab } from "./run-link";
import { runLineKey } from "./run-log-reader";
import {
	documentNodes,
	logOrigin,
	logScope,
	MASK,
	orderedChains,
	secretInputKeys,
	secretParams,
	stoppedSubflowLabel,
	stopSubflowTarget,
} from "./run-model";
import type { LoadedLine } from "./task-log-reader";
import { MONITOR_TOPBAR_HEIGHT } from "./top-bar";
import { type RunLogs, runLogDownloadPath, useRunLogs } from "./use-run-logs";
import { type TaskLogs, taskLogDownloadPath, useTaskLogs } from "./use-task-logs";

const TABS: [PanelTab, string][] = [
	["logs", "日志"],
	["actions", TERM.action],
	["attempts", "尝试"],
	["io", "输入输出"],
	["artifacts", "产物"],
];

/** 日志级别筛选：只看这一级及以上。 */
type MinLevel = "all" | "info" | "warn" | "error";
const MIN_LEVELS: [MinLevel, string][] = [
	["all", "全部"],
	["info", LOG_LEVEL_LABEL.info],
	["warn", LOG_LEVEL_LABEL.warn],
	["error", LOG_LEVEL_LABEL.error],
];
const levelsFrom = (min: MinLevel): LogLineView["level"][] =>
	min === "all" ? [] : LOG_LEVELS.slice(LOG_LEVELS.indexOf(min));

/**
 * 默认高度：监控页（窗口减去顶栏）高度的 28%，限制在 190–320px（`PANEL_FLOOR`），矮窗口里给图表工作区留出空间。
 * 拖动调整后用拖动的高度。
 */
const DEFAULT_HEIGHT = `clamp(${PANEL_FLOOR}px, calc((100dvh - ${MONITOR_TOPBAR_HEIGHT}px) * 0.28), 320px)`;
const COLLAPSED_HEIGHT = 37;

const ERROR_KIND_LABEL: Record<string, string> = {
	node_error: "节点错误",
	timeout: "超时",
	agent_lost: "Agent 断线",
	env_error: "环境错误",
	config_error: "配置错误",
};

/**
 * 底部面板（原型 bpBody）：日志、动作、尝试、输入输出、产物五个页签，范围跟随时间线上选中的节点
 * （共享状态 scope，规则在 monitor-scope.ts）；没有选中节点时跟随图表工作区的节点筛选（共享状态 filter），两者都没有时是全部节点：
 * 日志页签把范围内节点的日志合并显示（#222、#224），点来源节点名切到这个节点的单节点日志。
 * 节点有多次尝试时可以切换尝试（默认最近一次）。上沿可以拖动调整高度，双击恢复默认（默认高度、按内容自动收起）。
 * 页签与展开状态在共享状态里（顶栏的失败摘要会切到「尝试」页签）。用户还没有展开 / 收起、拖动或切换过页签时，
 * 日志页签没有内容（选中的节点还没开始、或日志加载完是空的）就自动收起，把高度让给图表；日志到了再自动展开。
 * 展开时占满图表工作区下面的全部高度（不低于默认高度），拖动调整后用拖动的高度。
 */
export function BottomPanel({
	run,
	doc,
	chartsReserved,
}: {
	run: RunView;
	doc: StoredOrchestrationDocument | undefined;
	/** 图表工作区要留出的高度（px）：面板最高到容器的高度减去它，见 `CHARTS_RESERVED_HEIGHT`。 */
	chartsReserved: number;
}) {
	const zoom = useMonitor((s) => s.zoom);
	const filter = useMonitor((s) => s.filter);
	const filtered = filter ? [...filter].filter((k) => k !== PLATFORM_KEY).length : 0;
	const scope = useScope(run);
	const { selected, node, attempt, tab } = scope;
	const actions = useMonitorActions();
	const [height, setHeight] = useState<number | null>(null);
	const panel = useRef<HTMLElement>(null);
	/** 「动作」页签的筛选条件，记在这里：切到日志再回来还在；换了尝试（任务）就回到不筛选。 */
	const [actionFilterOf, setActionFilterOf] = useState<{ taskId: string; filter: ActionFilter }>();
	const logTab = useRef<HTMLButtonElement>(null);
	const showOrigin = useCallback(
		(line: RunLogLine) =>
			actions.report({
				type: "origin",
				node: { chainInstanceId: line.chain_instance_id, nodeId: line.node_id },
				taskId: line.task_id,
			}),
		[actions],
	);
	const [minLevel, setMinLevel] = useState<MinLevel>("all");
	const levels = levelsFrom(minLevel);
	const levelFiltered = minLevel !== "all";
	// 日志在这里读，不在日志页签的内容里：面板按内容自动收起要先知道日志有没有内容，收起时内容也就不必挂着。
	// 选中节点时读它那一次尝试的日志，没有选中节点时读合并日志；不在日志页签、或用户收起了面板时不读。
	const mergedScope = useMemo(() => logScope(run, filter), [run, filter]);
	/** 没有选中节点时日志页签下载的合并日志：范围与合并视图相同。 */
	const mergedDownload = useMemo(
		() => runLogDownloadPath(run.id, mergedScope),
		[run.id, mergedScope],
	);
	const reading = readsLogs(scope);
	const taskLogs = useTaskLogs(reading && attempt ? attempt.task_id : null, levels, scope.locate);
	const runLogs = useRunLogs(reading && !node ? run.id : null, mergedScope, levels);
	const collapsed = !panelOpen(scope, hasNoLogs(attempt ? taskLogs : runLogs, levelFiltered));
	/** E 切到只看 ERROR 之前的级别：再按一次恢复。 */
	const levelBeforeErrors = useRef<MinLevel>("all");
	useShortcut("monitor-errors-only", () => {
		if (tab === "logs" && minLevel === "error") {
			setMinLevel(levelBeforeErrors.current);
			return;
		}
		if (minLevel !== "error") levelBeforeErrors.current = minLevel;
		setMinLevel("error");
		actions.report({ type: "tab", tab: "logs" });
	});
	const logTimeKind = useLogTimeKind();

	// 收起时只剩标签行；默认占满图表工作区下面剩下的高度；拖动以后是拖到的高度。默认的高度最高到图表工作区和底部面板
	// 共有的高度减去图表要留的高度（`chartsReserved`）：窗口变矮、时间线调高时先压面板，图表至少有那么高；
	// 窗口矮到两样都放不下时面板最矮是标签行（`minHeight`），图表再让到工具栏的高度，总在窗口里。
	const highest = `calc(100% - ${chartsReserved}px)`;
	// 用户自己拖高的：拖是明确的选择（要看日志、动作表），只留图表工具栏的高度；预留的高度只管默认的版面。
	const draggedHighest = `calc(100% - ${CHARTS_MIN_HEIGHT}px)`;
	const style: React.CSSProperties = collapsed
		? { height: COLLAPSED_HEIGHT }
		: height === null
			? { flex: `1 0 ${DEFAULT_HEIGHT}`, maxHeight: highest, minHeight: COLLAPSED_HEIGHT }
			: { height, maxHeight: draggedHighest, minHeight: COLLAPSED_HEIGHT };
	// 「动作」页签上的个数：看着「动作」页签时由它的推送更新，没在看、任务还在执行时定时重新读。
	const actionSummary = useActionSummary(
		attempt?.task_id,
		attempt?.status === "running" && !(tab === "actions" && !collapsed) && STATUS_POLL_MS,
	).data;
	const actionsShown = actionSummary && actionSummary.total > 0 ? actionCount(actionSummary) : null;
	return (
		<section
			ref={panel}
			aria-label="底部面板"
			className="relative mt-auto flex min-h-0 flex-none flex-col border-t border-border-soft bg-surface"
			style={style}
		>
			<ResizeHandle
				label="调整底部面板高度"
				edge="top"
				size={height}
				measure={() => panel.current?.clientHeight ?? COLLAPSED_HEIGHT}
				min={COLLAPSED_HEIGHT}
				max={() => window.innerHeight * 0.7}
				onResize={(h) => {
					actions.report({ type: "panel", open: true });
					setHeight(h);
				}}
				onReset={() => {
					// 恢复默认：默认高度，展开与否回到按内容自动决定。
					actions.report({ type: "panel", open: null });
					setHeight(null);
				}}
			/>
			<Tabs
				value={tab}
				onValueChange={(value) => actions.report({ type: "tab", tab: value as PanelTab })}
				className="contents"
			>
				<div className="flex h-9 flex-none items-center border-b border-border-soft pl-1.5">
					<TabsList aria-label="底部面板" className="h-full gap-0 border-b-0 px-0">
						{TABS.map(([value, label]) => (
							<TabsTrigger
								key={value}
								value={value}
								ref={value === "logs" ? logTab : undefined}
								aria-label={
									value === "actions" && actionsShown !== null
										? `${TERM.action}，共 ${formatInteger(actionsShown)} 个`
										: undefined
								}
								className="relative -mb-0 h-full gap-0 border-b-0 px-3 pt-0 pb-0 text-fg-3 data-active:border-transparent data-active:text-fg-1 data-active:after:absolute data-active:after:right-2 data-active:after:bottom-0 data-active:after:left-2 data-active:after:h-0.5 data-active:after:bg-primary"
							>
								{label}
								{value === "actions" && actionsShown !== null && (
									<span aria-hidden className="ml-1 font-mono text-2xs text-fg-3">
										{formatMetric(actionsShown)}
									</span>
								)}
							</TabsTrigger>
						))}
					</TabsList>
					<div className="ml-auto flex items-center gap-1.5 px-2">
						<ScopeLabel
							node={node}
							suffix={
								(node && attempt && node.attempts.length > 1
									? `（${attemptLabel(attempt.attempt)}）`
									: "") + (zoom && tab === "logs" ? " · 已按时间范围过滤" : "")
							}
							onClear={() => actions.report({ type: "select", node: null })}
						>
							{filter ? `范围：跟随筛选（${filtered} 个节点）` : "范围：全部节点"}
						</ScopeLabel>
						{node && node.attempts.length > 1 && (
							<Segmented
								label="尝试"
								value={attempt?.task_id ?? ""}
								options={node.attempts.map((a) => [a.task_id, attemptLabel(a.attempt)])}
								onChange={(taskId) => actions.report({ type: "attempt", taskId })}
							/>
						)}
						{tab === "logs" && (
							<>
								<Segmented
									label="日志时间"
									value={logTimeKind}
									options={LOG_TIME_KINDS}
									onChange={(v) => setLogTimeKind(v as LogTimeKind)}
								/>
								<Segmented
									label="日志级别"
									value={minLevel}
									options={MIN_LEVELS}
									onChange={(v) => setMinLevel(v as MinLevel)}
								/>
								{(attempt || !node) && (
									<a
										className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
										aria-label={attempt ? "下载原始日志" : "下载合并日志"}
										title={
											attempt
												? "下载原始日志（JSONL）"
												: "下载范围内全部节点合并后的日志（JSONL，不受级别筛选影响）"
										}
										href={attempt ? taskLogDownloadPath(attempt.task_id) : mergedDownload}
										download
									>
										<DownloadIcon />
									</a>
								)}
							</>
						)}
						<Button
							variant="ghost"
							size="sm"
							onClick={() => actions.report({ type: "panel", open: collapsed })}
						>
							{collapsed ? ACTION.expand : ACTION.collapse}
						</Button>
					</div>
				</div>
				{!collapsed && (
					<TabsContent
						value={tab}
						tabIndex={-1}
						// 各页签的滚动区都预留滚动条的位置：切换页签、内容变长时宽度不跳。
						className="overflow-hidden shadow-inset-top [&_.overflow-auto]:[scrollbar-gutter:stable]"
					>
						{tab === "logs" &&
							(attempt ? (
								<TaskLogsTab
									key={attempt.task_id}
									attempt={attempt}
									logs={taskLogs}
									moment={scope.locate}
									filtered={levelFiltered}
									timeKind={logTimeKind}
									day={run.started_at}
								/>
							) : node ? (
								<Hint>{noAttempt(node)}</Hint>
							) : (
								<RunLogsTab
									key={run.id}
									run={run}
									filter={filter}
									logs={runLogs}
									filtered={levelFiltered}
									timeKind={logTimeKind}
									day={run.started_at}
									onOrigin={showOrigin}
								/>
							))}
						{tab === "actions" &&
							(attempt && node ? (
								<ActionsTab
									key={attempt.task_id}
									node={node}
									attempt={attempt}
									day={run.started_at}
									filter={
										actionFilterOf?.taskId === attempt.task_id ? actionFilterOf.filter : NO_FILTER
									}
									onFilter={(filter) => setActionFilterOf({ taskId: attempt.task_id, filter })}
									onLocate={(at) => {
										if (!selected) return;
										actions.report({ type: "locate", node: selected, at });
										// 「动作」页签被日志换掉，焦点不留在已经消失的按钮上：交给日志页签。
										logTab.current?.focus();
									}}
								/>
							) : (
								<Hint>{node ? noAttempt(node) : "在时间线上选中一个节点，查看它的动作。"}</Hint>
							))}
						{tab === "attempts" && (
							<AttemptsTab run={run} node={node} selected={selected} filter={filter} doc={doc} />
						)}
						{tab === "io" && <IoTab node={node} attempt={attempt} doc={doc} />}
						{tab === "artifacts" &&
							(attempt ? (
								<ArtifactsTab attempt={attempt} />
							) : (
								<Hint>{node ? noAttempt(node) : "在时间线上选中一个节点，查看它的产物。"}</Hint>
							))}
					</TabsContent>
				)}
			</Tabs>
		</section>
	);
}

/**
 * 底部面板的范围：选中节点时是「范围：显示名称（节点 ID）」加上 `suffix`（第几次尝试、按时间范围过滤），
 * 放不下时只截断显示名称；没有选中节点时是 `children`（全部节点或跟随筛选）加上 `suffix`。
 */
function ScopeLabel({
	node,
	suffix,
	onClear,
	children,
}: {
	node: NodeRunView | undefined;
	suffix: string;
	onClear: () => void;
	children: ReactNode;
}) {
	if (node === undefined) {
		return (
			<span className="text-xs text-fg-3" data-testid="bp-scope">
				{children}
				{suffix}
			</span>
		);
	}
	const name = nameBeforeId(node.node_id, node.display_name);
	return (
		<span className="inline-flex h-6 max-w-96 min-w-0 items-center rounded-md border border-border bg-raised pl-2 text-xs text-fg-1">
			<span data-testid="bp-scope" className="flex min-w-0 whitespace-nowrap">
				范围：
				{name && <Truncate>{name}</Truncate>}
				<span className="flex-none">
					{name ? `（${node.node_id}）` : node.node_id}
					{suffix}
				</span>
			</span>
			<button
				type="button"
				aria-label={`清除范围，不再只看 ${runNodeName(node)}`}
				title={`清除范围（${shortcutText("monitor-deselect")}）`}
				onClick={onClear}
				className="grid size-5.5 place-items-center rounded-md text-fg-3 hover:bg-raised-2 hover:text-fg-1"
			>
				<XIcon aria-hidden className="size-3" />
			</button>
		</span>
	);
}

const noAttempt = (node: NodeRunView) => `${runNodeName(node)} ${NODE_STATUS[node.status].notRun}`;

function Segmented({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: string;
	options: readonly (readonly [string, string])[];
	onChange: (value: string) => void;
}) {
	return (
		<fieldset aria-label={label} className="flex rounded-md border border-border p-px">
			{options.map(([v, text]) => (
				<button
					key={v}
					type="button"
					aria-pressed={value === v}
					onClick={() => onChange(v)}
					className="h-5.5 rounded-sm px-2 text-xs text-fg-2 aria-pressed:bg-raised-2 aria-pressed:text-fg-1"
				>
					{text}
				</button>
			))}
		</fieldset>
	);
}

/** 日志读完了、一行也没有：面板按内容自动收起的依据。筛选了级别时不算（筛掉的是用户自己要的）；没读、还在读也不算。 */
const hasNoLogs = (logs: LogPaging & { lines: unknown[]; loaded: boolean }, filtered: boolean) =>
	!filtered && logs.loaded && logs.lines.length === 0 && !logs.hasOlder && !logs.hasNewer;

function TaskLogsTab({
	attempt,
	logs,
	moment,
	filtered,
	timeKind,
	day,
}: {
	attempt: AttemptView;
	logs: TaskLogs;
	/** 要在这次尝试的日志里定位的时刻；不定位时为 null。 */
	moment: LogMoment | null;
	filtered: boolean;
	timeKind: LogTimeKind;
	day: string;
}) {
	const reveal = useMemo<LogReveal<LoadedLine> | undefined>(() => {
		if (!logs.located || !moment) return undefined;
		const { at_offset, exact_seq } = logs.located;
		return {
			id: logs.located,
			at: new Date(moment.at).toISOString(),
			exact: exact_seq === null ? null : (line) => line.seq === exact_seq,
			fromMoment: (line) => line.offset >= at_offset,
		};
	}, [logs.located, moment]);
	return (
		<LogsView
			logs={logs}
			reveal={reveal}
			lineKey={seqKey}
			truncated={logs.truncated ? MESSAGE.logTruncated : null}
			filtered={filtered}
			noOutput={attempt.ended_at !== null ? "这次尝试没有日志输出。" : MESSAGE.logOutputPending}
			timeKind={timeKind}
			day={day}
		/>
	);
}

const seqKey = (line: LogLineView) => String(line.seq);

/**
 * 范围内节点的日志合并显示（#222）：没有节点筛选时是整次运行全部节点，有筛选时是筛选出的节点（#224）；
 * 每行多一列来源节点，向上滚动加载更早的（#223）；级别筛选在服务端执行，范围或级别变了重新加载。
 */
function RunLogsTab({
	run,
	filter,
	logs,
	filtered,
	timeKind,
	day,
	onOrigin,
}: {
	run: RunView;
	/** 图表工作区的节点筛选；null 是全部节点。 */
	filter: ReadonlySet<string> | null;
	logs: RunLogs;
	filtered: boolean;
	timeKind: LogTimeKind;
	day: string;
	onOrigin: (line: RunLogLine) => void;
}) {
	const origin = useCallback((line: RunLogLine) => logOrigin(run, line), [run]);
	const truncated = logs.truncatedTasks.map((t) => logOrigin(run, t)).join("、");
	return (
		<LogsView
			logs={logs}
			lineKey={runLineKey}
			origin={origin}
			onOrigin={onOrigin}
			truncated={truncated ? `${truncated} 的${MESSAGE.logTruncated}` : null}
			filtered={filtered}
			scoped={filter !== null}
			noOutput={run.ended_at !== null ? "这次运行没有日志输出。" : MESSAGE.logOutputPending}
			timeKind={timeKind}
			day={day}
		/>
	);
}

/** 日志页签的内容（单个任务与合并视图共用）：截断、旧行、读取失败的提示，按时间范围过滤，点一行标出时刻。 */
function LogsView<L extends LogLineView>({
	logs,
	reveal,
	lineKey,
	origin,
	onOrigin,
	truncated,
	filtered,
	scoped = false,
	noOutput,
	timeKind,
	day,
}: {
	logs: LogPaging & {
		lines: L[];
		loaded: boolean;
		expired: boolean;
		error: string | null;
	};
	/** 定位到某一刻；不给时是普通的日志。 */
	reveal?: LogReveal<L>;
	lineKey: (line: L) => string;
	/** 来源节点列；不给时没有这一列。 */
	origin?: (line: L) => string;
	/** 选中这一行的来源节点；不给时来源节点名不能点。 */
	onOrigin?: (line: L) => void;
	/** 截断提示；没有截断时为 null。 */
	truncated: string | null;
	/** 筛选了级别：没有日志时，说明文字是没有符合条件的日志。面板要不要自动收起不在这里判断，见 `hasNoLogs`。 */
	filtered: boolean;
	/** 只看筛选出的节点：这些节点里没有日志时，说明文字也是没有符合条件的日志。 */
	scoped?: boolean;
	/** 没有任何日志时的说明。 */
	noOutput: string;
	/** 时间列显示哪一种时间；定位和按时间范围过滤始终用控制面时间。 */
	timeKind: LogTimeKind;
	/** 运行开始的时刻：时间列要不要带日期按它那一天判断。 */
	day: string;
}) {
	const zoom = useMonitor((s) => s.zoom);
	const marker = useMonitor((s) => s.marker);
	const actions = useMonitorActions();
	const [markedKey, setMarkedKey] = useState<string | null>(null);
	// 按时间范围过滤只看控制面时间（时间线是按它画的）；没有控制面时间的行不在任何范围里。
	const lines = useMemo(
		() =>
			zoom
				? logs.lines.filter((l) => {
						if (l.time === null) return false;
						const t = Date.parse(l.time);
						return t >= zoom.start && t <= zoom.end;
					})
				: logs.lines,
		[logs.lines, zoom],
	);
	const unlocatable = useMemo(() => logs.lines.filter((l) => l.time === null).length, [logs.lines]);
	// 标记被别处清除（或换了标记）时取消行的高亮。
	const marked =
		markedKey !== null &&
		marker !== null &&
		logs.lines.some(
			(l) => lineKey(l) === markedKey && l.time !== null && Date.parse(l.time) === marker,
		)
			? markedKey
			: null;

	if (!logs.loaded) return <Hint>{MESSAGE.loading}</Hint>;
	return (
		<div className="flex h-full flex-col">
			{truncated && (
				<p className="m-0 flex-none border-b border-border-soft px-3 py-1 text-xs text-warn-fg">
					{truncated}
				</p>
			)}
			{unlocatable > 0 && (
				<p
					data-testid="logs-unlocatable"
					className="m-0 flex-none border-b border-border-soft px-3 py-1 text-xs text-fg-3"
				>
					{logs.hasOlder ? "已加载的日志里有" : "有"} {unlocatable}{" "}
					行日志没有记录控制面时间（升级之前写入的日志只有 Agent
					时间）：这些行不能在时间轴上定位，按时间范围过滤时也不显示。
				</p>
			)}
			{logs.error && (
				<p role="alert" className="m-0 flex-none px-3 py-1 text-xs text-danger-fg">
					读取日志失败：
					<UntrustedText text={logs.error} mode="text" />
				</p>
			)}
			{lines.length === 0 && !logs.hasOlder && !logs.hasNewer ? (
				<Hint>
					{logs.expired
						? MESSAGE.logsExpired
						: filtered || scoped || zoom
							? `${MESSAGE.noMatch("日志")}。`
							: noOutput}
				</Hint>
			) : (
				<div className="min-h-0 flex-1">
					<LogList
						lines={lines}
						lineKey={lineKey}
						origin={origin}
						onOrigin={onOrigin}
						paging={logs}
						reveal={reveal}
						marked={marked}
						timeKind={timeKind}
						day={day}
						onPick={(line) => {
							if (line.time === null) return;
							const key = lineKey(line);
							const same = marked === key;
							setMarkedKey(same ? null : key);
							actions.mark(same ? null : Date.parse(line.time));
						}}
					/>
				</div>
			)}
		</div>
	);
}

/** 错误信息里空行之后是堆栈（Agent 拼接 message 与 traceback）。 */
function splitError(message: string): { message: string; stack: string | null } {
	const at = message.indexOf("\n\n");
	return at < 0
		? { message, stack: null }
		: { message: message.slice(0, at), stack: message.slice(at + 2) };
}

function AttemptsTab({
	run,
	node,
	selected,
	filter,
	doc,
}: {
	run: RunView;
	node: NodeRunView | undefined;
	selected: NodeRef | null;
	filter: ReadonlySet<string> | null;
	doc: StoredOrchestrationDocument | undefined;
}) {
	const { now } = useTimeAxis();
	// 没选节点时列出有重试或失败的节点（有节点筛选时只列筛选中的）。
	const nodes = node
		? [node]
		: orderedChains(run)
				.flatMap((c) =>
					c.nodes.filter(
						(n) => !filter || filter.has(nodeKey({ chainInstanceId: c.id, nodeId: n.node_id })),
					),
				)
				.filter((n) => n.attempts.length > 1 || n.attempts.some((a) => a.error));
	if (nodes.length === 0) {
		return <Hint>{selected ? noAttempt(node as NodeRunView) : "没有重试或失败的节点。"}</Hint>;
	}
	const cards = nodes.flatMap((n) => n.attempts.map((a) => ({ n, a })));
	if (cards.length === 0) return <Hint>{noAttempt(nodes[0] as NodeRunView)}</Hint>;
	return (
		<div className="grid h-full auto-rows-min grid-cols-[repeat(auto-fill,minmax(380px,1fr))] gap-2 overflow-auto p-3">
			{cards.map(({ n, a }) => {
				const status = nodeStatusView(a.status);
				const error = a.error ? splitError(a.error.message) : null;
				const end = a.ended_at ? Date.parse(a.ended_at) : now;
				// 时钟偏差达到阈值时，开始和结束除了控制面时间还给出 Agent 时间（ADR 0018）。
				const agentTimes = attemptAgentTimes(a);
				return (
					<article
						key={a.task_id}
						aria-label={`${runNodeName(n)} ${attemptLabel(a.attempt)}`}
						className={cn(
							"rounded-lg border bg-bg p-2.5 text-xs",
							a.error ? "border-danger-line" : "border-border-soft",
						)}
					>
						<header className="flex items-center gap-2">
							{/* 卡片很窄：显示名称优先，放不下时先收起节点 ID，名称占满再截断（和时间线的名称列一样）。 */}
							<NodeName node={n} priority="name" />
							<b className="flex-none font-semibold">{attemptLabel(a.attempt)}</b>
							<StatusPill kind={status.kind}>{status.label}</StatusPill>
							<span className="ml-auto flex-none font-mono text-2xs text-fg-3">
								<UntrustedText text={a.agent ?? "控制面"} /> ·{" "}
								{a.started_at ? formatClock(a.started_at) : "未开始"} ·{" "}
								{a.started_at ? formatDuration(end - Date.parse(a.started_at)) : "—"}
							</span>
						</header>
						{a.queue_wait && (
							<p className="m-0 mt-1.5 text-xs text-fg-2">
								<QueueWaitNote wait={a.queue_wait} queuedAt={a.queued_at} now={now} />
							</p>
						)}
						{agentTimes && (
							// 每一头的说明不在中间断开：换行只落在标点后面，不会剩下一个「天」字。
							<p className="m-0 mt-1.5 text-xs text-warn-fg">
								这个任务执行期间 Agent 时间与控制面不一致：
								{agentTimes.details.map((part, i) => (
									<span key={part} className="whitespace-nowrap">
										{part}
										{i < agentTimes.details.length - 1 && "，"}
									</span>
								))}
							</p>
						)}
						<dl className="m-0 mt-1.5 grid grid-cols-[48px_1fr] gap-x-2 font-mono text-xs text-fg-2 [&_dt]:font-sans [&_dt]:text-fg-3">
							<dt>排队</dt>
							<dd className="m-0">{formatClock(a.queued_at)}</dd>
							<dt>开始</dt>
							<dd className="m-0">
								{a.started_at ? formatClock(a.started_at) : "—"}
								{agentTimes?.start && (
									<span data-agent-time>（Agent 时间 {formatFullDateTime(agentTimes.start)}）</span>
								)}
							</dd>
							{n.kind === "stop_subflow" && stopSubflowTarget(doc, n.node_id) !== undefined && (
								<>
									<dt>停止</dt>
									<dd className="m-0 font-sans">
										{stoppedSubflowLabel(run, stopSubflowTarget(doc, n.node_id) as string)}
									</dd>
								</>
							)}
							<dt>结束</dt>
							<dd className="m-0">
								{a.ended_at ? formatClock(a.ended_at) : "—"}
								{agentTimes?.end && (
									<span data-agent-time>（Agent 时间 {formatFullDateTime(agentTimes.end)}）</span>
								)}
							</dd>
						</dl>
						{a.error && error && (
							<div className="mt-2">
								<div className="flex items-center gap-2">
									<Badge variant="danger" title={untrustedPlain(a.error.kind)}>
										<UntrustedText text={ERROR_KIND_LABEL[a.error.kind] ?? a.error.kind} />
										<code className="font-mono">
											<UntrustedText text={a.error.kind} />
										</code>
									</Badge>
								</div>
								<p className="m-0 mt-1 text-danger-fg">
									<UntrustedText mode="text" text={error.message || "（没有错误信息）"} />
								</p>
								{a.error.location && (
									<p
										data-testid="attempt-error-location"
										className="m-0 mt-1 font-mono text-xs text-fg-2"
									>
										{ERROR_LOCATION_LABEL}：<UntrustedText text={a.error.location} />
									</p>
								)}
								{error.stack && (
									<pre className="m-0 mt-1.5 max-h-80 overflow-auto rounded-md bg-sunk p-2 font-mono text-xs leading-5 wrap-anywhere whitespace-pre-wrap text-fg-2">
										<UntrustedText mode="text" text={error.stack} />
									</pre>
								)}
							</div>
						)}
					</article>
				);
			})}
		</div>
	);
}

const ARTIFACT_REF =
	/^https?:\/\/[^\s"]*\/tasks\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/artifacts\/([^\s"?#]+)$/i;

/** 产物引用（对 Agent 可见的完整地址，每个路径段已编码）对应的浏览器下载地址；不是产物引用时为 null。 */
const artifactRefPath = (value: string) => {
	const m = ARTIFACT_REF.exec(value);
	if (!m?.[1] || !m[2]) return null;
	try {
		return artifactDownloadPath(m[1], m[2].split("/").map(decodeURIComponent).join("/"));
	} catch {
		return null; // 不是合法的百分号编码
	}
};

export const artifactDownloadPath = (taskId: string, name: string) =>
	apiUrl(artifactsApi.download, { params: { id: taskId, "*": name } });

/**
 * JSON 展示；字符串值是产物引用时显示为下载链接。字符串（键和值）是别人写的：`JSON.stringify` 只转义 U+0020 以下的控制字符，
 * 行分隔符、改变文字方向的字符、零宽字符都留在里面，所以每个字符串各自过 `UntrustedText`（方向隔离在这个字符串里，
 * 不带乱外面的括号和缩进）；字符串之外只有括号、冒号、逗号、数字、空白，原样显示。
 */
function JsonBlock({ value }: { value: unknown }) {
	const text = JSON.stringify(value, null, 2) ?? "";
	const parts: ReactNode[] = [];
	let last = 0;
	for (const m of text.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
		parts.push(text.slice(last, m.index));
		const path = artifactRefPath(JSON.parse(m[0]) as string);
		parts.push(
			path ? (
				<a key={m.index} href={path} download className={INLINE_LINK} title="下载产物">
					<UntrustedText mode="text" text={m[0]} />
				</a>
			) : (
				<UntrustedText key={m.index} mode="text" text={m[0]} />
			),
		);
		last = m.index + m[0].length;
	}
	parts.push(text.slice(last));
	return (
		<pre className="m-0 overflow-auto rounded-md border border-border-soft bg-sunk p-2.5 font-mono text-xs whitespace-pre text-fg-1">
			{parts}
		</pre>
	);
}

/** 运行视图里被省略的输入、输出的大小（向上取整到 KiB 的字节数）：「约 17 KB」。 */
const omittedSize = (bytes: number) =>
	bytes >= 1024 * 1024
		? `约 ${(bytes / 1024 / 1024).toFixed(1)} MB`
		: `约 ${Math.round(bytes / 1024)} KB`;

/**
 * 运行视图里被省略的大输入或输出（#633）：写明大小，点「加载」才取全文；加载中、加载失败（可以重试）各有自己的样子。
 * 运行视图只给大小，不给内容：打开页面不会因为几十个大输出把响应撑到几十 MB。
 */
function OmittedValue({
	bytes,
	loading,
	error,
	onLoad,
}: {
	bytes: number;
	loading: boolean;
	error: string | null;
	onLoad: () => void;
}) {
	return (
		<div data-testid="io-omitted" className="flex flex-wrap items-center gap-2 text-xs text-fg-3">
			{/* 不说为什么被省略（单个太大，或者整份视图里这一份放不下）：两种情况是同一句。 */}
			<span>没有随运行一起返回（{omittedSize(bytes)}）。</span>
			{/* 加载中用 aria-disabled 而不是 disabled：键盘按下去之后焦点还在这个按钮上，不会掉到页面上。 */}
			<Button
				size="sm"
				aria-disabled={loading || undefined}
				className="aria-disabled:cursor-wait aria-disabled:opacity-40"
				onClick={loading ? undefined : onLoad}
			>
				{loading ? "加载中…" : error ? "重试" : "加载"}
			</Button>
			{error && (
				<span role="alert" className="text-danger-fg">
					无法加载：{error}
				</span>
			)}
		</div>
	);
}

function IoTab({
	node,
	attempt,
	doc,
}: {
	node: NodeRunView | undefined;
	attempt: AttemptView | undefined;
	doc: StoredOrchestrationDocument | undefined;
}) {
	const secretKeys = useMemo(
		() =>
			node ? secretInputKeys(documentNodes(doc).get(node.node_id), secretParams(doc)) : new Set(),
		[node, doc],
	);
	// 被省略的大输入、输出：点「加载」才取这次尝试的全文（输入和输出一起来）。取回的按任务缓在查询缓存里，
	// 运行还在变（事件流推来新的视图）、切到别的尝试再回来，已经加载的都不丢。
	// 注意：执行中的尝试，输入在派发时写下，输出到结束才写：执行中取到的全文里输出是 null。所以「取到了没有」按输入、输出各自看：
	// 视图说这一项被省略、缓存里这一项却是空的，就是还没取到（尝试结束之后输出被省略了），照样显示占位，点「加载」重新取。
	const [requested, setRequested] = useState<string | null>(null);
	const taskId = attempt?.task_id;
	const full = useQuery({
		...apiQuery(runsApi.taskIo, { params: { id: taskId ?? "" } }),
		enabled: taskId !== undefined && requested === taskId,
		// 已经结束的尝试的输入输出写下就不再变；执行中取到的不算数的部分由上面「各自看」处理。
		staleTime: Number.POSITIVE_INFINITY,
	});
	// 用键盘按「加载」之后，加载出来的内容取代了按钮：焦点不能落到页面上，移到那一栏的内容上。
	const [focusAfter, setFocusAfter] = useState<{
		taskId: string;
		side: "inputs" | "outputs";
	} | null>(null);
	const inputsBox = useRef<HTMLDivElement>(null);
	const outputsBox = useRef<HTMLDivElement>(null);
	const fullInputs = full.data?.inputs ?? null;
	const fullOutputs = full.data?.outputs ?? null;
	const inputsMissing = attempt?.inputs_omitted_bytes != null && fullInputs === null;
	const outputsMissing = attempt?.outputs_omitted_bytes != null && fullOutputs === null;
	useEffect(() => {
		if (!focusAfter || focusAfter.taskId !== taskId) return;
		const missing = focusAfter.side === "inputs" ? inputsMissing : outputsMissing;
		if (missing) return;
		(focusAfter.side === "inputs" ? inputsBox : outputsBox).current?.focus();
		setFocusAfter(null);
	}, [focusAfter, taskId, inputsMissing, outputsMissing]);
	if (!node) return <Hint>在时间线上选中一个节点，查看它已解析的输入和输出。</Hint>;
	if (!attempt) return <Hint>{noAttempt(node)}</Hint>;
	const load = (side: "inputs" | "outputs") => {
		setFocusAfter({ taskId: attempt.task_id, side });
		if (requested === attempt.task_id) void full.refetch();
		else setRequested(attempt.task_id);
	};
	const loading = requested === attempt.task_id && full.isFetching;
	const error = !full.data && full.isError ? full.error.message : null;
	const placeholder = (bytes: number, side: "inputs" | "outputs") => (
		<OmittedValue bytes={bytes} loading={loading} error={error} onLoad={() => load(side)} />
	);
	// 被省略的内容取到之后用全文；没取到之前是占位。
	const rawInputs = attempt.inputs_omitted_bytes === null ? attempt.inputs : fullInputs;
	const outputs = attempt.outputs_omitted_bytes === null ? attempt.outputs : fullOutputs;
	const inputs =
		rawInputs &&
		Object.fromEntries(
			Object.entries(rawInputs).map(([k, v]) => [k, secretKeys.has(k) ? MASK : v]),
		);
	return (
		<div className="grid h-full grid-cols-2 gap-2.5 overflow-auto p-3">
			<div ref={inputsBox} tabIndex={-1} className="min-w-0">
				<h3 className="m-0 mb-1.5 text-xs font-semibold text-fg-3">
					输入（已解析，secret 值已打码）
				</h3>
				{inputsMissing ? (
					placeholder(attempt.inputs_omitted_bytes as number, "inputs")
				) : inputs ? (
					<JsonBlock value={inputs} />
				) : (
					<p className="m-0 text-xs text-fg-3">派发时才解析输入。</p>
				)}
			</div>
			<div ref={outputsBox} tabIndex={-1} className="min-w-0">
				<h3 className="m-0 mb-1.5 text-xs font-semibold text-fg-3">输出</h3>
				{outputsMissing ? (
					placeholder(attempt.outputs_omitted_bytes as number, "outputs")
				) : outputs ? (
					<JsonBlock value={outputs} />
				) : (
					<p className="m-0 text-xs text-fg-3">
						{attempt.ended_at ? "没有输出。" : "节点尚未结束。"}
					</p>
				)}
			</div>
		</div>
	);
}

function ArtifactsTab({ attempt }: { attempt: AttemptView }) {
	// 状态变化（尤其是结束）时重新加载：产物在上报结果之前上传完。
	const query = useQuery(apiQuery(artifactsApi.list, { params: { id: attempt.task_id } }));
	const { refetch } = query;
	// biome-ignore lint/correctness/useExhaustiveDependencies: 状态变化时重新获取
	useEffect(() => void refetch(), [attempt.status, refetch]);
	if (query.error)
		return (
			<Hint>
				无法加载产物：
				<ErrorMessage error={query.error} />
			</Hint>
		);
	if (!query.data) return <Hint>{MESSAGE.loading}</Hint>;
	if (query.data.expired) return <Hint>这次运行的产物已超过保留期，已被清理。</Hint>;
	if (query.data.artifacts.length === 0) return <Hint>这次尝试没有产物。</Hint>;
	return (
		<ul aria-label="产物" className="m-0 h-full list-none overflow-auto p-3">
			{query.data.artifacts.map((a) => (
				<li
					key={a.name}
					className="mb-1.5 flex items-center gap-3 rounded-lg border border-border-soft bg-bg px-3 py-2"
				>
					<div className="min-w-0 flex-1">
						<div className="truncate text-sm">
							<UntrustedText text={a.name} />
						</div>
						<div className="truncate font-mono text-2xs text-fg-3" title={a.sha256}>
							{formatBytes(a.size)} · sha256 {a.sha256.slice(0, 12)}
						</div>
					</div>
					{/* 主列是文件在 Agent 上的修改时间（Agent 时间），上传时间是控制面时间（ADR 0018）。 */}
					<div className="grid shrink-0 grid-cols-[auto_auto] gap-x-2 text-xs text-fg-3">
						<span>Agent 修改</span>
						<span
							title="文件在 Agent 上的修改时间（Agent 时间）"
							className={cn("font-mono", a.agent_modified_at && "text-fg")}
						>
							{a.agent_modified_at ? formatFullDateTime(a.agent_modified_at) : TIME_NOT_RECORDED}
						</span>
						<span>上传</span>
						<span title="上传到控制面的时间（控制面时间）" className="font-mono">
							{formatFullDateTime(a.created_at)}
						</span>
					</div>
					<a
						className={buttonVariants({ size: "sm" })}
						href={artifactDownloadPath(attempt.task_id, a.name)}
						download
						aria-label={`下载 ${untrustedPlain(a.name)}`}
					>
						<DownloadIcon />
						下载
					</a>
				</li>
			))}
		</ul>
	);
}
