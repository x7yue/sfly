import {
	type AttemptView,
	artifactsApi,
	LOG_LEVELS,
	type LogLineView,
	type NodeRunView,
	type OrchestrationDocument,
	type RunView,
} from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { DownloadIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { nodeStatusView, StatusPill } from "#/components/status";
import { apiQuery, apiUrl } from "#/lib/api";
import { formatBytes, formatClock, formatDuration, formatFullDateTime } from "#/lib/format";
import { NODE_STATUS } from "#/lib/node-status";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { attemptAgentTimes } from "./attempt-clock";
import { LogList } from "./LogList";
import {
	type NodeRef,
	nodeKey,
	type PanelTab,
	PLATFORM_KEY,
	useMonitor,
	useMonitorActions,
	useTimeAxis,
} from "./monitor-state";
import { ResizeHandle } from "./ResizeHandle";
import {
	documentNodes,
	findNode,
	MASK,
	orderedChains,
	secretInputKeys,
	secretParams,
	stoppedSubflowLabel,
} from "./run-model";
import { MONITOR_TOPBAR_HEIGHT } from "./top-bar";
import { taskLogDownloadPath, useTaskLogs } from "./use-task-logs";

const TABS: [PanelTab, string][] = [
	["logs", "日志"],
	["attempts", "尝试"],
	["io", "输入输出"],
	["artifacts", "产物"],
];

/** 日志级别筛选：只看这一级及以上。 */
type MinLevel = "all" | "info" | "warn" | "error";
const MIN_LEVELS: [MinLevel, string][] = [
	["all", "全部"],
	["info", "INFO"],
	["warn", "WARN"],
	["error", "ERROR"],
];
const levelsFrom = (min: MinLevel): LogLineView["level"][] =>
	min === "all" ? [] : LOG_LEVELS.slice(LOG_LEVELS.indexOf(min));

/**
 * 默认高度：监控页（窗口减去顶栏）高度的 28%，限制在 160–320px，矮窗口里给图表工作区留出空间。
 * 拖动调整后用拖动的高度。
 */
const DEFAULT_HEIGHT = `clamp(160px, calc((100dvh - ${MONITOR_TOPBAR_HEIGHT}px) * 0.28), 320px)`;
const COLLAPSED_HEIGHT = 37;

const ERROR_KIND_LABEL: Record<string, string> = {
	node_error: "节点错误",
	timeout: "超时",
	agent_lost: "Agent 断线",
	env_error: "环境错误",
	config_error: "配置错误",
};

/**
 * 底部面板（原型 bpBody）：日志、尝试、输入输出、产物四个页签，范围跟随时间线上选中的节点
 * （共享状态 selected）；没有选中节点时跟随图表工作区的节点筛选（共享状态 filter）。节点有多次尝试时可以切换尝试（默认最近一次）。上沿可以拖动调整高度，双击恢复默认（默认高度、按内容自动收起）。
 * 页签与展开状态在共享状态里（顶栏的失败摘要会切到「尝试」页签）。用户还没有展开 / 收起、拖动或切换过页签时，
 * 日志页签没有内容（没选中节点、节点还没开始、或日志加载完是空的）就自动收起，把高度让给图表；日志到了再自动展开。
 */
export function BottomPanel({
	run,
	doc,
}: {
	run: RunView;
	doc: OrchestrationDocument | undefined;
}) {
	const selected = useMonitor((s) => s.selected);
	const zoom = useMonitor((s) => s.zoom);
	const filter = useMonitor((s) => s.filter);
	const filtered = filter ? [...filter].filter((k) => k !== PLATFORM_KEY).length : 0;
	const tab = useMonitor((s) => s.panelTab);
	const panelOpen = useMonitor((s) => s.panelOpen);
	const actions = useMonitorActions();
	const [height, setHeight] = useState<number | null>(null);
	/** 日志页签加载完、没有任何日志（自动收起的依据）。 */
	const [logsEmpty, setLogsEmpty] = useState(false);
	const panel = useRef<HTMLElement>(null);
	const node = findNode(run, selected);
	const [attemptId, setAttemptId] = useState<string | null>(null);
	const refKey = selected ? `${selected.chainInstanceId}:${selected.nodeId}` : "";
	// biome-ignore lint/correctness/useExhaustiveDependencies: 换节点时回到最近一次尝试
	useEffect(() => setAttemptId(null), [refKey]);
	const attempt =
		node?.attempts.find((a) => a.task_id === attemptId) ?? node?.attempts.at(-1) ?? undefined;
	const [minLevel, setMinLevel] = useState<MinLevel>("all");

	const empty = tab === "logs" && (!attempt || logsEmpty);
	const collapsed = panelOpen === null ? empty : !panelOpen;
	const effective = collapsed ? COLLAPSED_HEIGHT : (height ?? DEFAULT_HEIGHT);
	return (
		<section
			ref={panel}
			aria-label="底部面板"
			className="relative flex flex-none flex-col border-t border-border-soft bg-surface"
			style={{ height: effective }}
		>
			<ResizeHandle
				label="调整底部面板高度"
				edge="top"
				height={height}
				measure={() => panel.current?.clientHeight ?? COLLAPSED_HEIGHT}
				min={COLLAPSED_HEIGHT}
				max={() => window.innerHeight * 0.7}
				onResize={(h) => {
					actions.setPanelOpen(true);
					setHeight(h);
				}}
				onReset={() => {
					// 恢复默认：默认高度，展开与否回到按内容自动决定。
					actions.setPanelOpen(null);
					setHeight(null);
				}}
			/>
			<div className="flex h-9 flex-none items-center border-b border-border-soft pl-1.5">
				<div role="tablist" aria-label="底部面板" className="flex h-full">
					{TABS.map(([value, label]) => (
						<button
							key={value}
							type="button"
							role="tab"
							id={`bp-tab-${value}`}
							aria-selected={tab === value}
							aria-controls="bp-panel"
							onClick={() => actions.showPanel(value)}
							className="relative h-full px-3 text-sm text-fg-3 hover:text-fg-1 aria-selected:text-fg-1 aria-selected:after:absolute aria-selected:after:right-2 aria-selected:after:bottom-0 aria-selected:after:left-2 aria-selected:after:h-0.5 aria-selected:after:bg-primary"
						>
							{label}
						</button>
					))}
				</div>
				<div className="ml-auto flex items-center gap-1.5 px-2">
					<span className="text-xs text-fg-3" data-testid="bp-scope">
						{node
							? `范围：${node.node_id}`
							: filter
								? `范围：跟随筛选（${filtered} 个节点）`
								: "范围：未选中节点"}
						{node && attempt && node.attempts.length > 1 ? `（第 ${attempt.attempt} 次）` : ""}
						{zoom && tab === "logs" ? " · 已按时间范围过滤" : ""}
					</span>
					{node && node.attempts.length > 1 && (
						<Segmented
							label="尝试"
							value={attempt?.task_id ?? ""}
							options={node.attempts.map((a) => [a.task_id, `第 ${a.attempt} 次`])}
							onChange={setAttemptId}
						/>
					)}
					{tab === "logs" && (
						<>
							<Segmented
								label="日志级别"
								value={minLevel}
								options={MIN_LEVELS}
								onChange={(v) => setMinLevel(v as MinLevel)}
							/>
							{attempt && (
								<a
									className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
									aria-label="下载原始日志"
									title="下载原始日志（JSONL）"
									href={taskLogDownloadPath(attempt.task_id)}
									download
								>
									<DownloadIcon />
								</a>
							)}
						</>
					)}
					<Button variant="ghost" size="sm" onClick={() => actions.setPanelOpen(collapsed)}>
						{collapsed ? "展开" : "收起"}
					</Button>
				</div>
			</div>
			{/* 自动收起时内容仍然挂着（隐藏）：日志到了能自动展开。 */}
			{(!collapsed || panelOpen === null) && (
				<div
					id="bp-panel"
					role="tabpanel"
					aria-labelledby={`bp-tab-${tab}`}
					hidden={collapsed}
					className="min-h-0 flex-1 overflow-hidden shadow-inset-top"
				>
					{tab === "logs" &&
						(attempt ? (
							<LogsTab
								key={attempt.task_id}
								attempt={attempt}
								levels={levelsFrom(minLevel)}
								filtered={minLevel !== "all"}
								onEmpty={setLogsEmpty}
							/>
						) : (
							<Hint>{node ? noAttempt(node) : "在时间线上选中一个节点，查看它的日志。"}</Hint>
						))}
					{tab === "attempts" && (
						<AttemptsTab run={run} node={node} selected={selected} filter={filter} />
					)}
					{tab === "io" && <IoTab node={node} attempt={attempt} doc={doc} />}
					{tab === "artifacts" &&
						(attempt ? (
							<ArtifactsTab attempt={attempt} />
						) : (
							<Hint>{node ? noAttempt(node) : "在时间线上选中一个节点，查看它的产物。"}</Hint>
						))}
				</div>
			)}
		</section>
	);
}

const noAttempt = (node: NodeRunView) => `${node.node_id} ${NODE_STATUS[node.status].notRun}`;

function Hint({ children }: { children: ReactNode }) {
	return <p className="m-0 p-4 text-sm text-fg-3">{children}</p>;
}

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

function LogsTab({
	attempt,
	levels,
	filtered,
	onEmpty,
}: {
	attempt: AttemptView;
	levels: LogLineView["level"][];
	filtered: boolean;
	/** 加载完、没有任何日志时为 true（筛选了级别时不算空：那是用户自己筛掉的）。 */
	onEmpty: (empty: boolean) => void;
}) {
	const logs = useTaskLogs(attempt.task_id, levels);
	const empty = !filtered && logs.loaded && logs.lines.length === 0 && !logs.hasOlder;
	useEffect(() => onEmpty(empty), [empty, onEmpty]);
	useEffect(() => () => onEmpty(false), [onEmpty]);
	const zoom = useMonitor((s) => s.zoom);
	const marker = useMonitor((s) => s.marker);
	const actions = useMonitorActions();
	const [markedSeq, setMarkedSeq] = useState<number | null>(null);
	const lines = useMemo(
		() =>
			zoom
				? logs.lines.filter((l) => {
						const t = Date.parse(l.time);
						return t >= zoom.start && t <= zoom.end;
					})
				: logs.lines,
		[logs.lines, zoom],
	);
	// 标记被别处清除（或换了标记）时取消行的高亮。
	const marked =
		markedSeq !== null &&
		marker !== null &&
		logs.lines.some((l) => l.seq === markedSeq && Date.parse(l.time) === marker)
			? markedSeq
			: null;
	const finished = attempt.ended_at !== null;

	if (!logs.loaded) return <Hint>正在加载日志…</Hint>;
	return (
		<div className="flex h-full flex-col">
			{logs.truncated && (
				<p className="m-0 flex-none border-b border-border-soft px-3 py-1 text-xs text-warn-fg">
					日志超过单个任务的大小上限，之后的输出已被截断。
				</p>
			)}
			{logs.error && (
				<p role="alert" className="m-0 flex-none px-3 py-1 text-xs text-danger-fg">
					读取日志失败：{logs.error}
				</p>
			)}
			{lines.length === 0 && !logs.hasOlder ? (
				<Hint>
					{logs.expired
						? "这次运行的日志已超过保留期，已被清理。"
						: filtered || zoom
							? "没有符合条件的日志。"
							: finished
								? "这次尝试没有日志输出。"
								: "还没有日志输出。"}
				</Hint>
			) : (
				<div className="min-h-0 flex-1">
					<LogList
						lines={lines}
						hasOlder={logs.hasOlder}
						loadingOlder={logs.loadingOlder}
						loadOlder={logs.loadOlder}
						marked={marked}
						onPick={(line) => {
							const same = marked === line.seq;
							setMarkedSeq(same ? null : line.seq);
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
}: {
	run: RunView;
	node: NodeRunView | undefined;
	selected: NodeRef | null;
	filter: ReadonlySet<string> | null;
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
						aria-label={`${n.node_id} 第 ${a.attempt} 次尝试`}
						className={cn(
							"rounded-lg border bg-bg p-2.5 text-xs",
							a.error ? "border-danger-line" : "border-border-soft",
						)}
					>
						<header className="flex items-center gap-2">
							<span className="font-mono">{n.node_id}</span>
							<b className="font-medium">第 {a.attempt} 次</b>
							<StatusPill kind={status.kind}>{status.label}</StatusPill>
							<span className="ml-auto font-mono text-2xs text-fg-3">
								{a.agent ?? "控制面"} · {a.started_at ? formatClock(a.started_at) : "未开始"} ·{" "}
								{a.started_at ? formatDuration(end - Date.parse(a.started_at)) : "—"}
							</span>
						</header>
						{agentTimes && (
							<p className="m-0 mt-1.5 text-2xs text-warn-fg">
								这个任务执行期间 Agent 时间与控制面不一致：{agentTimes.detail}
							</p>
						)}
						<dl className="m-0 mt-1.5 grid grid-cols-[48px_1fr] gap-x-2 font-mono text-2xs text-fg-2 [&_dt]:font-sans [&_dt]:text-fg-3">
							<dt>排队</dt>
							<dd className="m-0">{formatClock(a.queued_at)}</dd>
							<dt>开始</dt>
							<dd className="m-0">
								{a.started_at ? formatClock(a.started_at) : "—"}
								{agentTimes?.start && `（Agent 时间 ${formatFullDateTime(agentTimes.start)}）`}
							</dd>
							{a.wake_at && (
								<>
									<dt>唤醒</dt>
									<dd className="m-0">{formatClock(a.wake_at)}</dd>
								</>
							)}
							{n.kind === "stop_subflow" && typeof a.inputs?.subflow === "string" && (
								<>
									<dt>停止</dt>
									<dd className="m-0 font-sans">{stoppedSubflowLabel(run, a.inputs.subflow)}</dd>
								</>
							)}
							<dt>结束</dt>
							<dd className="m-0">
								{a.ended_at ? formatClock(a.ended_at) : "—"}
								{agentTimes?.end && `（Agent 时间 ${formatFullDateTime(agentTimes.end)}）`}
							</dd>
						</dl>
						{a.error && error && (
							<div className="mt-2">
								<div className="flex items-center gap-2">
									<Badge variant="danger" title={a.error.kind}>
										{ERROR_KIND_LABEL[a.error.kind] ?? a.error.kind}
										<code className="font-mono">{a.error.kind}</code>
									</Badge>
								</div>
								<p className="m-0 mt-1 text-danger-fg">{error.message || "（没有错误信息）"}</p>
								{error.stack && (
									<pre className="m-0 mt-1.5 max-h-40 overflow-auto rounded-md bg-sunk p-2 font-mono text-2xs whitespace-pre text-fg-2">
										{error.stack}
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

/** JSON 展示；字符串值是产物引用时显示为下载链接。 */
function JsonBlock({ value }: { value: unknown }) {
	const text = JSON.stringify(value, null, 2) ?? "";
	const parts: ReactNode[] = [];
	let last = 0;
	for (const m of text.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
		const path = artifactRefPath(JSON.parse(m[0]) as string);
		if (!path) continue;
		parts.push(text.slice(last, m.index));
		parts.push(
			<a
				key={m.index}
				href={path}
				download
				className="underline underline-offset-2"
				title="下载产物"
			>
				{m[0]}
			</a>,
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

function IoTab({
	node,
	attempt,
	doc,
}: {
	node: NodeRunView | undefined;
	attempt: AttemptView | undefined;
	doc: OrchestrationDocument | undefined;
}) {
	const secretKeys = useMemo(
		() =>
			node ? secretInputKeys(documentNodes(doc).get(node.node_id), secretParams(doc)) : new Set(),
		[node, doc],
	);
	if (!node) return <Hint>在时间线上选中一个节点，查看它已解析的输入和输出。</Hint>;
	if (!attempt) return <Hint>{noAttempt(node)}</Hint>;
	const inputs =
		attempt.inputs &&
		Object.fromEntries(
			Object.entries(attempt.inputs).map(([k, v]) => [k, secretKeys.has(k) ? MASK : v]),
		);
	return (
		<div className="grid h-full grid-cols-2 gap-2.5 overflow-auto p-3">
			<div className="min-w-0">
				<h3 className="m-0 mb-1.5 text-xs font-medium text-fg-3">输入（已解析，敏感值已打码）</h3>
				{inputs ? (
					<JsonBlock value={inputs} />
				) : (
					<p className="m-0 text-xs text-fg-3">派发时才解析输入。</p>
				)}
			</div>
			<div className="min-w-0">
				<h3 className="m-0 mb-1.5 text-xs font-medium text-fg-3">输出</h3>
				{attempt.outputs ? (
					<JsonBlock value={attempt.outputs} />
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
	if (query.error) return <Hint>无法加载产物：{query.error.message}</Hint>;
	if (!query.data) return <Hint>正在加载产物…</Hint>;
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
						<div className="truncate text-sm">{a.name}</div>
						<div className="truncate font-mono text-2xs text-fg-3" title={a.sha256}>
							{formatBytes(a.size)} · sha256 {a.sha256.slice(0, 12)}
						</div>
					</div>
					{/* 主列是文件在 Agent 上的修改时间（Agent 时间），上传时间是控制面时间（ADR 0018）。 */}
					<div className="grid shrink-0 grid-cols-[auto_auto] gap-x-2 text-2xs text-fg-3">
						<span>Agent 修改</span>
						<span
							title="文件在 Agent 上的修改时间（Agent 时间）"
							className={cn("font-mono", a.agent_modified_at && "text-fg")}
						>
							{a.agent_modified_at ? formatFullDateTime(a.agent_modified_at) : "未记录"}
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
						aria-label={`下载 ${a.name}`}
					>
						<DownloadIcon />
						下载
					</a>
				</li>
			))}
		</ul>
	);
}
