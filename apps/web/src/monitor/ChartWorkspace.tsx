import {
	type CatalogNode,
	isOnAgentStatus,
	type MetricSeries,
	type PlatformMetrics,
	type RunView,
} from "@sfly/schema";
import { useQueries } from "@tanstack/react-query";
import { cn } from "cn";
import { BarChart3Icon, ChevronDownIcon, ChevronRightIcon, SearchIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ErrorState } from "#/components/feedback/states";
import { type StatusKind, StatusPill } from "#/components/status";
import { formatDuration } from "#/lib/format";
import { PrimaryMetric } from "#/metrics/PrimaryMetric";
import { primaryMetricData } from "#/metrics/use-primary-metric";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { buildGroups, type ChartGroup, groupHasData, isActive, isFailed } from "./chart-groups";
import { balancedColumns, chartWindow } from "./charts";
import { type ChartLine, MetricChart } from "./MetricChart";
import { nodeKey, PLATFORM_KEY, useMonitor, useMonitorActions, useTimeAxis } from "./monitor-state";
import { NodeFilter } from "./NodeFilter";
import { chainLabel } from "./run-model";
import type { TimeRange } from "./timeline";
import {
	attemptsSignature,
	seriesQuery,
	useMetricCatalog,
	usePlatformMetrics,
} from "./use-run-metrics";

const PLATFORM_TEXT = "平台自带图表 节点耗时 槽位 并发 重试";
const PLATFORM_CHARTS = 4;
const MIN_COLUMN = { standard: 340, compact: 230 };
type Density = keyof typeof MIN_COLUMN;
/** 分组内外的水平留白（px）：工作区 12×2、分组 10×2、描边。 */
const GROUP_INSET = 48;

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * 图表工作区（原型 monitorHTML 的 wsp 部分）：工具栏（节点筛选、图表搜索、全部展开 / 折叠、密度）吸顶；
 * 每个上报指标的包节点一组，按链上的执行顺序，组标题显示状态、名称、主指标的最新值与迷你趋势、图表数与 Agent；
 * 平台自带图表是最后一组。默认只展开执行中与失败的组，打开页面时滚到第一个执行中或失败的组（或选中的节点）；
 * 选中节点时展开它的组、滚到可见处，并在组内顶部显示节点摘要。悬停、缩放、日志标记与时间线共享（monitor-state.tsx）。
 */
export function ChartWorkspace({ run }: { run: RunView }) {
	const { range, live, now } = useTimeAxis();
	const zoom = useMonitor((s) => s.zoom);
	const filter = useMonitor((s) => s.filter);
	const selected = useMonitor((s) => s.selected);
	const actions = useMonitorActions();
	const signature = useMemo(() => attemptsSignature(run), [run]);
	const catalog = useMetricCatalog(run.id, signature);
	const platform = usePlatformMetrics(run.id, signature, live);
	const groups = useMemo(() => buildGroups(run, catalog.data?.nodes ?? []), [run, catalog.data]);

	const [search, setSearch] = useState("");
	const [density, setDensity] = useState<Density>("standard");
	const [opened, setOpened] = useState<Record<string, boolean>>({});
	const scroller = useRef<HTMLElement>(null);
	const toolbar = useRef<HTMLDivElement>(null);
	const width = useWidth(scroller);

	// 每个分组一个序列查询（最新一次尝试）；缩放时按缩放范围查询，得到更细的桶。
	const seriesResults = useQueries({
		queries: groups.map((g) =>
			seriesQuery(
				run.id,
				{
					chain_instance_id: g.ref.chainInstanceId,
					node_id: g.ref.nodeId,
					attempt: g.attempt.attempt,
					...(zoom && {
						from: iso(Math.floor(zoom.start / 1000) * 1000),
						to: iso(Math.ceil(zoom.end / 1000) * 1000),
					}),
				},
				!!g.runAttempt?.ended_at,
			),
		),
	});
	const seriesByKey = new Map(groups.map((g, i) => [g.key, seriesResults[i]]));

	const query = search.trim().toLowerCase();
	const matches = (text: string) => text.toLowerCase().includes(query);
	const inFilter = (key: string) => !filter || filter.has(key);
	const shown = groups
		.filter((g) => inFilter(g.key))
		.map((g) => ({
			group: g,
			charts:
				!query || matches(g.ref.nodeId) || matches(`${g.entry.package}/${g.entry.node}`)
					? g.entry.charts
					: g.entry.charts.filter((c) => matches(c.title)),
		}))
		.filter((x) => x.charts.length > 0);
	const showPlatform = inFilter(PLATFORM_KEY) && (!query || PLATFORM_TEXT.includes(query));
	const chartCount =
		shown.reduce((n, x) => n + x.charts.length, 0) + (showPlatform ? PLATFORM_CHARTS : 0);

	const defaultOpen = (g: ChartGroup) => !!filter || !!query || isActive(g) || isFailed(g);
	const isOpen = (key: string, fallback: boolean) => opened[key] ?? fallback;
	const platformOpen = isOpen(PLATFORM_KEY, !!filter || !!query);

	const changeFilter = (next: ReadonlySet<string> | null, open: Record<string, boolean> = {}) => {
		actions.setFilter(next);
		setOpened(open);
		// 筛选变化时回到顶部。
		if (scroller.current) scroller.current.scrollTop = 0;
	};
	const setAll = (open: boolean) =>
		setOpened(
			Object.fromEntries([...groups.map((g) => g.key), PLATFORM_KEY].map((k) => [k, open])),
		);

	// 打开页面时滚到选中节点或第一个执行中 / 失败的组；之后选中节点时展开它的组并滚到可见处。
	const [scrollTo, setScrollTo] = useState<string | null>(null);
	const selectedKey = selected ? nodeKey(selected) : null;
	const lastSelected = useRef<string | null | undefined>(undefined);
	const groupKeys = groups.map((g) => g.key).join("|");
	// biome-ignore lint/correctness/useExhaustiveDependencies: 只在目录与选中节点变化时定位
	useEffect(() => {
		if (!catalog.data) return;
		const first = lastSelected.current === undefined;
		if (!first && lastSelected.current === selectedKey) return;
		lastSelected.current = selectedKey;
		const target = groups.find((g) => g.key === selectedKey)?.key;
		if (target) {
			setOpened((o) => ({ ...o, [target]: true }));
			setScrollTo(target);
		} else if (first) {
			const busy = groups.find((g) => isActive(g) || isFailed(g));
			if (busy) setScrollTo(busy.key);
		}
	}, [catalog.data, selectedKey, groupKeys]);
	useLayoutEffect(() => {
		if (!scrollTo) return;
		setScrollTo(null);
		const box = scroller.current;
		const el = box?.querySelector<HTMLElement>(`[data-group="${CSS.escape(scrollTo)}"]`);
		if (!box || !el) return;
		const top = el.offsetTop - (toolbar.current?.offsetHeight ?? 0) - 8;
		const visible = top >= box.scrollTop && el.offsetTop + 40 <= box.scrollTop + box.clientHeight;
		if (!visible) box.scrollTop = Math.max(0, top);
	}, [scrollTo]);

	const nodes = filter ? [...filter].filter((k) => k !== PLATFORM_KEY) : [];
	const filterLabel = !filter
		? "全部节点"
		: nodes.length === 1 && !filter.has(PLATFORM_KEY)
			? (groups.find((g) => g.key === nodes[0])?.ref.nodeId ?? "已选 1 个节点")
			: `已选 ${nodes.length} 个节点`;
	const minColumn = MIN_COLUMN[density];
	const dense = density === "compact";

	return (
		<section
			ref={scroller}
			aria-label="图表工作区"
			className="relative min-h-60 flex-1 overflow-auto px-3 pb-7"
		>
			<div
				ref={toolbar}
				role="toolbar"
				aria-label="图表工具栏"
				className="sticky top-0 z-4 -mx-3 mb-2.5 flex flex-wrap items-center gap-2 border-b border-border-soft bg-bg px-3 pt-2.5 pb-2"
			>
				<NodeFilter
					label={filterLabel}
					groups={groups}
					filter={filter}
					hasData={(g) => groupHasData(g, seriesByKey.get(g.key)?.data)}
					onChange={(next) => changeFilter(next)}
				/>
				{filter && (
					<Button variant="ghost" size="sm" onClick={() => changeFilter(null)}>
						清除筛选
					</Button>
				)}
				<span className="text-xs text-fg-3" data-testid="chart-count">
					{shown.length} 个节点 · {chartCount} 张图表
					{filter ? "" : ` · 共 ${groups.length} 个节点声明了图表`}
				</span>
				<div className="relative w-55">
					<SearchIcon
						aria-hidden
						className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-fg-3"
					/>
					<Input
						aria-label="搜索图表或节点"
						placeholder="搜索图表或节点"
						value={search}
						onChange={(e) => {
							setSearch(e.target.value);
							setOpened({});
						}}
						className="h-6.5 pl-7 text-xs"
					/>
				</div>
				<span className="flex-1" />
				<Button variant="ghost" size="sm" onClick={() => setAll(true)}>
					全部展开
				</Button>
				<Button variant="ghost" size="sm" onClick={() => setAll(false)}>
					全部折叠
				</Button>
				<Segmented
					label="图表密度"
					value={density}
					onChange={setDensity}
					options={[
						{ value: "standard", label: "标准" },
						{ value: "compact", label: "紧凑" },
					]}
					className="h-6.5"
				/>
			</div>

			{catalog.error && !catalog.data ? (
				<ErrorState
					title="无法加载指标"
					error={catalog.error}
					onRetry={() => void catalog.refetch()}
					className="mb-2.5"
				/>
			) : !catalog.data ? (
				<output aria-label="加载中" aria-busy="true" className="mb-2.5 flex flex-col gap-2.5">
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
				</output>
			) : catalog.data.expired ? (
				<Notice>这次运行的指标数据已超过保留期，已被清理。</Notice>
			) : groups.length === 0 ? (
				<Notice>这次运行没有节点上报指标。节点类型声明了指标后，图表会按节点显示在这里。</Notice>
			) : shown.length === 0 && !showPlatform ? (
				<Notice>没有匹配的图表。</Notice>
			) : null}

			{shown.map(({ group, charts }) => (
				<NodeGroup
					key={group.key}
					group={group}
					charts={charts}
					series={seriesByKey.get(group.key)?.data}
					loading={!!seriesByKey.get(group.key)?.isPending}
					open={isOpen(group.key, defaultOpen(group))}
					onToggle={(open) => setOpened((o) => ({ ...o, [group.key]: open }))}
					onlyThis={
						filter?.size === 1 && filter.has(group.key)
							? undefined
							: () => changeFilter(new Set([group.key]), { [group.key]: true })
					}
					selected={selectedKey === group.key}
					columns={balancedColumns(charts.length, width - GROUP_INSET, minColumn)}
					dense={dense}
					range={range}
					zoomed={!!zoom}
					now={now}
				/>
			))}
			{showPlatform && (
				<PlatformGroup
					run={run}
					data={platform.data}
					error={platform.error}
					open={platformOpen}
					onToggle={(open) => setOpened((o) => ({ ...o, [PLATFORM_KEY]: open }))}
					columns={balancedColumns(PLATFORM_CHARTS - 1, width - GROUP_INSET, minColumn)}
					dense={dense}
					range={range}
					now={now}
				/>
			)}
		</section>
	);
}

function Notice({ children }: { children: React.ReactNode }) {
	return (
		<div className="mb-2.5 flex items-center gap-2 rounded-xl border border-border-soft bg-surface px-4 py-6 text-sm text-fg-3">
			<BarChart3Icon aria-hidden className="size-4.5 flex-none" />
			{children}
		</div>
	);
}

/** 元素的内容宽度（随窗口与面板变化）。 */
function useWidth(ref: React.RefObject<HTMLElement | null>) {
	const [width, setWidth] = useState(1280);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		setWidth(el.clientWidth);
		const observer = new ResizeObserver(() => setWidth(el.clientWidth));
		observer.observe(el);
		return () => observer.disconnect();
	}, [ref]);
	return width;
}

const ACCENT: Partial<Record<StatusKind, string>> = {
	running: "var(--signal)",
	failed: "var(--danger)",
};

function GroupShell({
	groupKey,
	label,
	selected,
	open,
	onToggle,
	header,
	actions,
	children,
}: {
	groupKey: string;
	label: string;
	selected?: boolean;
	open: boolean;
	onToggle: (open: boolean) => void;
	header: React.ReactNode;
	actions?: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<section
			aria-label={label}
			data-group={groupKey}
			data-selected={selected || undefined}
			className="mb-2.5 rounded-xl border border-border-soft bg-surface data-selected:border-selected"
		>
			<div className="flex items-center gap-2 py-1 pr-2">
				<button
					type="button"
					aria-expanded={open}
					onClick={() => onToggle(!open)}
					className="flex h-8 min-w-0 flex-1 items-center gap-2 pl-3 text-left text-sm whitespace-nowrap"
				>
					<span className="grid w-3.5 flex-none place-items-center text-fg-3">
						{open ? (
							<ChevronDownIcon className="size-3.5" />
						) : (
							<ChevronRightIcon className="size-3.5" />
						)}
					</span>
					{header}
				</button>
				{actions}
			</div>
			{open && children}
		</section>
	);
}

function NodeGroup({
	group,
	charts,
	series,
	loading,
	open,
	onToggle,
	onlyThis,
	selected,
	columns,
	dense,
	range,
	zoomed,
	now,
}: {
	group: ChartGroup;
	charts: CatalogNode["charts"];
	series: MetricSeries | undefined;
	loading: boolean;
	open: boolean;
	onToggle: (open: boolean) => void;
	onlyThis: (() => void) | undefined;
	selected: boolean;
	columns: number;
	dense: boolean;
	range: TimeRange;
	zoomed: boolean;
	now: number;
}) {
	const { entry, node, chain, attempt, runAttempt, status } = group;
	const units = new Map(entry.metrics.map((m) => [m.name, m.unit]));
	const linesOf = (names: readonly string[]): ChartLine[] =>
		names.map((name) => ({
			name,
			buckets: series?.series.find((s) => s.name === name)?.buckets ?? [],
		}));
	const window = runAttempt ? chartWindow(runAttempt, range, now) : null;
	const truncated = attempt.truncated || !!series?.truncated;
	const empty = !runAttempt?.started_at
		? "节点尚未开始 · 暂无数据"
		: !window || zoomed
			? "所选时间段内无数据"
			: loading
				? "正在加载…"
				: runAttempt.ended_at
					? "这次尝试没有上报数据"
					: "还没有上报数据";
	const title = `${entry.package}/${entry.node}`;
	return (
		<GroupShell
			groupKey={group.key}
			label={`${node.node_id} 的图表`}
			selected={selected}
			open={open}
			onToggle={onToggle}
			header={
				<>
					<StatusPill kind={status.kind}>{status.label}</StatusPill>
					<span className="flex-none font-mono font-medium">{node.node_id}</span>
					<span className="min-w-0 truncate text-fg-2">{title}</span>
					{group.chainName && (
						<span className="flex-none text-2xs text-fg-3" title={chainLabel(chain)}>
							{group.chainName}
						</span>
					)}
					{entry.primary_metric && (
						<PrimaryMetric
							variant="chip"
							data={primaryMetricData(entry.primary_metric, entry, attempt, series)}
							accent={ACCENT[status.kind] ?? "var(--fg-3)"}
						/>
					)}
					<span className="flex-1" />
					{truncated && (
						<Badge variant="warn" title="指标数据超过单个任务的上限，之后的点已被丢弃">
							数据已截断
						</Badge>
					)}
					{attempt.dropped_points > 0 && (
						<Badge variant="warn" title="Agent 断线期间排队超过上限而丢弃的点">
							断线丢弃 {attempt.dropped_points} 个点
						</Badge>
					)}
					<span className="flex-none text-xs text-fg-3">{charts.length} 张图表</span>
					<span className="flex-none font-mono text-2xs text-fg-3">{node.agent ?? ""}</span>
				</>
			}
			actions={
				onlyThis && (
					<Button
						variant="ghost"
						size="sm"
						onClick={onlyThis}
						aria-label={`只看 ${node.node_id}`}
						title="只看这个节点的图表"
					>
						只看
					</Button>
				)
			}
		>
			<div
				className="grid gap-2 px-2.5 pb-2.5"
				style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
			>
				{selected && (
					<div className="col-span-full">
						<NodeSummary group={group} now={now} />
					</div>
				)}
				{charts.map((chart) => (
					<MetricChart
						key={chart.title}
						title={chart.title}
						type={chart.type}
						unit={units.get(chart.metrics[0] ?? "") ?? ""}
						lines={linesOf(chart.metrics)}
						bucketSeconds={series?.bucket_seconds ?? 1}
						window={window}
						empty={empty}
						dense={dense}
						accent={ACCENT[status.kind] ?? "var(--fg-3)"}
						truncated={truncated}
					/>
				))}
			</div>
		</GroupShell>
	);
}

/** 选中节点的摘要（组内顶部）：状态、节点类型、Agent、耗时、尝试、进度、错误。 */
function NodeSummary({ group, now }: { group: ChartGroup; now: number }) {
	const { node, entry, status } = group;
	const latest = node.attempts.at(-1);
	const started = latest?.started_at ? Date.parse(latest.started_at) : null;
	const ended = latest?.ended_at ? Date.parse(latest.ended_at) : now;
	const progress = latest?.progress;
	const item = (label: string, value: React.ReactNode) => (
		<div className="min-w-0">
			<div className="text-2xs text-fg-3">{label}</div>
			<div className="font-mono text-xs">{value}</div>
		</div>
	);
	return (
		<div
			data-testid="node-summary"
			className="flex flex-wrap items-center gap-6 rounded-lg border border-border-soft bg-bg px-3.5 py-2.5"
		>
			<StatusPill kind={status.kind}>{status.label}</StatusPill>
			{item("节点类型", `${entry.package}/${entry.node}@${entry.version}`)}
			{item("Agent", node.agent ?? "—")}
			{item("耗时", started === null ? "—" : formatDuration(ended - started))}
			{item("尝试", node.attempts.length)}
			{progress && (
				<div className="min-w-45">
					<div className="text-2xs text-fg-3">进度</div>
					<div className="font-mono text-xs">
						{progress.current}
						{progress.total === null ? "" : ` / ${progress.total}`}
						{progress.message && (
							<span className="ml-2 font-sans text-fg-2">{progress.message}</span>
						)}
					</div>
				</div>
			)}
			{node.error && (
				<div className="min-w-0">
					<div className="text-2xs text-fg-3">错误</div>
					<div className="flex items-center gap-1.5 text-xs">
						<Badge variant="danger">{node.error.kind}</Badge>
						<span className="truncate text-danger-fg">{node.error.message.split("\n\n")[0]}</span>
					</div>
				</div>
			)}
		</div>
	);
}

const toBuckets = (buckets: PlatformMetrics["concurrency"]) =>
	buckets.map((b) => ({
		time: b.time,
		points: 1,
		min: b.max,
		max: b.max,
		avg: b.avg,
		last: b.max,
	}));

/** 平台自带图表（由任务记录推导，不需要节点注册）：节点耗时 Top 10、Agent 槽位占用、并发任务数、重试次数。 */
function PlatformGroup({
	run,
	data,
	error,
	open,
	onToggle,
	columns,
	dense,
	range,
	now,
}: {
	run: RunView;
	data: PlatformMetrics | undefined;
	error: Error | null;
	open: boolean;
	onToggle: (open: boolean) => void;
	columns: number;
	dense: boolean;
	range: TimeRange;
	now: number;
}) {
	const window = data
		? chartWindow({ started_at: data.from, ended_at: run.ended_at }, range, now)
		: null;
	const empty = data ? "所选时间段内无数据" : error ? `无法加载：${error.message}` : "正在加载…";
	return (
		<GroupShell
			groupKey={PLATFORM_KEY}
			label="平台自带图表"
			open={open}
			onToggle={onToggle}
			header={
				<>
					<Badge>平台</Badge>
					<span className="font-medium">平台自带图表</span>
					<span className="min-w-0 truncate text-xs text-fg-3">
						节点耗时 · 槽位 · 并发 · 重试，不需要节点注册
					</span>
					<span className="flex-1" />
					<span className="text-xs text-fg-3">{PLATFORM_CHARTS} 张图表</span>
				</>
			}
		>
			<div
				className="grid gap-2 px-2.5 pb-2.5"
				style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
			>
				<div className="col-span-full">
					<NodeDurations run={run} data={data} />
				</div>
				<MetricChart
					title="Agent 槽位占用"
					type="area"
					unit="槽位"
					lines={(data?.agents ?? []).map((a) => ({
						name: a.slots === null ? a.name : `${a.name}（${a.slots} 槽位）`,
						buckets: toBuckets(a.occupancy),
					}))}
					bucketSeconds={data?.bucket_seconds ?? 1}
					window={window}
					empty={empty}
					dense={dense}
				/>
				<MetricChart
					title="并发任务数"
					type="line"
					unit="个"
					lines={[{ name: "执行中", buckets: toBuckets(data?.concurrency ?? []) }]}
					bucketSeconds={data?.bucket_seconds ?? 1}
					window={window}
					empty={empty}
					dense={dense}
				/>
				<figure
					aria-label="重试次数"
					className="relative m-0 min-w-0 rounded-lg border border-border-soft bg-bg px-2.5 pt-2 pb-1.5"
				>
					<figcaption className="text-xs text-fg-2">重试次数</figcaption>
					<div className="mt-1.5 mb-0.5 font-mono text-2xl font-semibold" data-latest>
						{data ? data.retries : "—"}
						<small className="ml-1 text-xs font-normal text-fg-3">次</small>
					</div>
					<div className="truncate text-xs text-fg-3">
						{data
							? data.nodes
									.filter((n) => n.retries > 0)
									.map((n) => `${n.node_id} ×${n.retries}`)
									.join("、") || "没有重试"
							: empty}
					</div>
				</figure>
			</div>
		</GroupShell>
	);
}

/** 节点耗时 Top 10：条长为总耗时（含排队与等待），斜纹部分是排队与等待。 */
function NodeDurations({ run, data }: { run: RunView; data: PlatformMetrics | undefined }) {
	const statusOf = new Map(
		run.chains.flatMap((c) => c.nodes.map((n) => [`${c.id}:${n.node_id}`, n.status])),
	);
	const nodes = [...(data?.nodes ?? [])]
		.filter((n) => n.duration_ms > 0)
		.sort((a, b) => b.duration_ms - a.duration_ms)
		.slice(0, 10);
	const max = Math.max(1, ...nodes.map((n) => n.duration_ms));
	return (
		<figure
			aria-label="节点耗时 Top 10"
			className="m-0 rounded-lg border border-border-soft bg-bg px-2.5 pt-2 pb-2"
		>
			<figcaption className="flex items-baseline gap-2 text-xs">
				<span className="text-fg-2">节点耗时 Top 10</span>
				<span className="text-2xs text-fg-3">含排队与等待</span>
			</figcaption>
			{nodes.length === 0 ? (
				<p className="m-0 mt-1.5 text-xs text-fg-3">
					{data ? "还没有节点开始执行。" : "正在加载…"}
				</p>
			) : (
				<ol className="m-0 mt-1.5 grid list-none grid-cols-[140px_1fr_64px] items-center gap-x-2.5 gap-y-1 p-0 text-xs">
					{nodes.map((n) => {
						const status = statusOf.get(`${n.chain_instance_id}:${n.node_id}`) ?? "";
						const waited = n.queue_ms + n.wait_ms;
						return (
							<li key={`${n.chain_instance_id}:${n.node_id}`} className="contents">
								<span className="truncate font-mono text-fg-2">{n.node_id}</span>
								<span className="relative h-2.5 overflow-hidden rounded-[2px] bg-track">
									<i
										className={cn(
											"absolute inset-y-0 left-0",
											isOnAgentStatus(status)
												? "bg-signal"
												: status === "failed"
													? "bg-danger"
													: "bg-ok/50",
										)}
										style={{ width: `${(n.duration_ms / max) * 100}%` }}
									/>
									{waited > 0 && (
										<i
											className="absolute inset-y-0 left-0 bg-[repeating-linear-gradient(135deg,var(--warn-line)_0_3px,var(--warn-soft)_3px_6px)]"
											style={{ width: `${(waited / max) * 100}%` }}
										/>
									)}
								</span>
								<span className="text-right font-mono text-fg-3">
									{formatDuration(n.duration_ms)}
								</span>
							</li>
						);
					})}
				</ol>
			)}
		</figure>
	);
}
