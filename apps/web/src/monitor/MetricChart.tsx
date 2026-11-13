import { bucketStartMs } from "@sfly/schema";
import { cn } from "cn";
import { memo, useCallback, useMemo, useState } from "react";
import { formatClock, formatMetric } from "#/lib/format";
import { Badge } from "@/components/ui/badge";
import {
	bucketAt,
	bucketTimes,
	type ChartBucket,
	colorSlots,
	envelopePoints,
	formatReading,
	hasSpread,
	latestLine,
	pickShown,
	type ShownPick,
	valueExtent,
} from "./charts";
import { useMonitor, useMonitorActions } from "./monitor-state";
import type { TimeRange } from "./timeline-model";

/**
 * 一张指标图表（原型 chartHTML / plotSVG）：折线、面积、柱状、数值卡四种类型，多序列时显示图例。
 * 每个序列（指标名 + 标签，#78）一条线，颜色按序列在这张图表里首次出现的顺序在 4 种主题色里轮换（之后不变）；
 * 点图例项显示或隐藏这条线，序列多于 10 个时默认只显示横轴范围内平均值最高的 10 个（charts.ts 的 defaultShown），
 * 只在用户改时间范围或出现新序列时重新挑选（pickShown）。
 * 标题栏的最新值见 charts.ts 的 latestLine：多条线且没有唯一的合计时不显示数值，读数在悬停提示里。
 * 横轴由调用方给出（节点实际运行的时段与时间线范围的交集，见 charts.ts 的 chartWindow）。
 * 悬停时把时刻写进共享状态（时间线和其他图表同步显示竖线与读数），日志标记画成琥珀色虚线。
 */

export type ChartType = "line" | "area" | "bar" | "stat";

export interface ChartLine {
	/** 图例里的名字（`data-series`）。 */
	name: string;
	/** 序列的身份（指标名 + 标签，见 @sfly/schema 的 seriesKey）；没有时用 name。 */
	key?: string;
	/** 带标签的指标的序列（标题栏的最新值优先取不带标签的合计，见 charts.ts 的 latestLine）。 */
	labeled?: boolean;
	buckets: readonly ChartBucket[];
}

const lineKey = (line: ChartLine) => line.key ?? line.name;

/** 截取到横轴范围、带上身份与颜色的序列。 */
interface DrawnLine extends ChartLine {
	key: string;
	color: string;
}

/** 多序列的线色（token chart-1 … chart-4，按颜色序号循环）。 */
export const SERIES_COLORS = [
	"var(--chart-1)",
	"var(--chart-2)",
	"var(--chart-3)",
	"var(--chart-4)",
];
const seriesColor = (i: number) => SERIES_COLORS[i % SERIES_COLORS.length] as string;

const W = 300;

export function MetricChart({
	title,
	type,
	unit,
	lines,
	bucketSeconds,
	window,
	empty,
	dense,
	truncated,
	notice,
	footnote,
}: {
	title: string;
	type: ChartType;
	unit: string;
	lines: readonly ChartLine[];
	bucketSeconds: number;
	/** 横轴；null 时显示 empty。 */
	window: TimeRange | null;
	/** 没有数据时的说明。 */
	empty: string;
	dense: boolean;
	truncated?: boolean;
	/** 标题旁的其他提示（例如「序列超限」），排在「已截断」之后。 */
	notice?: React.ReactNode;
	footnote?: React.ReactNode;
}) {
	const span = bucketSeconds * 1000;
	// 颜色序号按序列首次出现的顺序分配（显示或隐藏别的序列、运行中插入新序列时都不变）。
	const [slotState, setSlots] = useState<ReadonlyMap<string, number>>(new Map());
	const slots = colorSlots(slotState, lines.map(lineKey));
	if (slots !== slotState) setSlots(slots);
	const inWindow = useMemo(
		(): DrawnLine[] =>
			window
				? lines.map((l) => ({
						...l,
						key: lineKey(l),
						color: seriesColor(slots.get(lineKey(l)) ?? 0),
						buckets: l.buckets.filter((b) => {
							const t = bucketStartMs(b);
							return t + span > window.start && t <= window.end;
						}),
					}))
				: [],
		[lines, window, span, slots],
	);
	// 默认显示的序列：只在用户改时间范围（缩放、回到实时）或出现新序列时重新挑选。
	const zoom = useMonitor((s) => s.zoom);
	const [pickState, setPick] = useState<ShownPick | undefined>(undefined);
	const pick = pickShown(pickState, inWindow, zoom);
	if (pick !== pickState) setPick(pick);
	// 图例上点过的序列（身份 → 是否显示）覆盖默认。
	const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
	const isShown = useCallback(
		(key: string) => toggled.get(key) ?? pick.shown.has(key),
		[toggled, pick],
	);
	const visible = useMemo(() => inWindow.filter((l) => isShown(l.key)), [inWindow, isShown]);
	const toggle = (key: string) => setToggled((t) => new Map(t).set(key, !isShown(key)));
	const has = inWindow.some((l) => l.buckets.length > 0);
	const latestOf = type === "stat" ? inWindow[0] : latestLine(visible);
	const latest = latestOf?.buckets.at(-1)?.last;
	const shown = window && has ? window : null;

	return (
		<figure
			aria-label={title}
			data-chart={title}
			className="relative m-0 min-w-0 rounded-lg border border-border-soft bg-bg px-2.5 pt-2 pb-1.5"
		>
			<figcaption className="flex items-baseline gap-2 text-xs whitespace-nowrap">
				<span className="min-w-0 truncate text-fg-2">{title}</span>
				{truncated && (
					<Badge
						variant="warn"
						className="h-4 px-1"
						title="指标数据超过单个任务的上限，之后的点已被丢弃"
					>
						已截断
					</Badge>
				)}
				{notice}
				{shown && type !== "stat" && (
					<HoverReading lines={visible} window={shown} bucketSeconds={bucketSeconds} />
				)}
				{type !== "stat" &&
					(latestOf === null ? (
						// 不显示数值时留一个空的同字号占位：标题栏高度与基线不变，与同一行显示最新值的图表对齐。
						<span aria-hidden className="ml-auto font-mono text-sm">
							{"\u200b"}
						</span>
					) : (
						<span className="ml-auto font-mono text-sm font-semibold text-fg-1" data-latest>
							{latest === undefined ? "—" : formatMetric(latest)}
							<small className="ml-0.5 text-xs font-normal text-fg-3">{unit}</small>
						</span>
					))}
			</figcaption>
			{!shown ? (
				<div
					className={cn(
						"mt-1 grid place-items-center rounded-md border border-dashed border-border-soft text-xs text-fg-3",
						dense ? "h-14" : "h-24",
					)}
				>
					{empty}
				</div>
			) : type === "stat" ? (
				<>
					<div className="mt-1.5 mb-0.5 font-mono text-2xl font-semibold" data-latest>
						{latest === undefined ? "—" : formatMetric(latest)}
						<small className="ml-1 text-xs font-normal text-fg-3">{unit}</small>
					</div>
					<Plot
						type="area"
						lines={inWindow.slice(0, 1)}
						window={shown}
						bucketSeconds={bucketSeconds}
						height={30}
						mini
					/>
				</>
			) : (
				<>
					<Plot
						type={type}
						lines={visible}
						window={shown}
						bucketSeconds={bucketSeconds}
						height={dense ? 56 : 96}
						latestText={latest === undefined ? undefined : formatMetric(latest)}
					/>
					<div className="mt-0.5 flex items-start gap-x-2.5 text-xs text-fg-3">
						{inWindow.length > 1 && (
							// 序列很多时图例最多 4 行，其余滚动查看。
							<div className="flex max-h-16 min-w-0 flex-1 flex-wrap gap-x-2.5 overflow-y-auto">
								{inWindow.map((l) => (
									<button
										key={l.key}
										type="button"
										data-legend
										aria-pressed={isShown(l.key)}
										title={isShown(l.key) ? "点击隐藏这条曲线" : "点击显示这条曲线"}
										onClick={() => toggle(l.key)}
										className="inline-flex items-center gap-1 rounded-sm hover:text-fg-1 aria-[pressed=false]:opacity-45"
									>
										<i
											aria-hidden
											className="inline-block h-0.5 w-2.5"
											style={{ background: isShown(l.key) ? l.color : "var(--fg-3)" }}
										/>
										{l.name}
									</button>
								))}
							</div>
						)}
						<span className="ml-auto flex-none font-mono" data-window>
							{formatClock(shown.start)} – {formatClock(shown.end)}
						</span>
					</div>
				</>
			)}
			{footnote}
		</figure>
	);
}

/**
 * 标题栏里的悬停时刻；只显示一条线时带上它在那一刻的值（桶里有范围时带最小–最大值）。
 * 显示多条线时，各条线的值在绘图区的悬停提示里（HoverValues）。
 */
function HoverReading({
	lines,
	window,
	bucketSeconds,
}: {
	lines: readonly ChartLine[];
	window: TimeRange;
	bucketSeconds: number;
}) {
	const hoverAt = useMonitor((s) => s.hoverAt);
	if (hoverAt === null || hoverAt < window.start || hoverAt > window.end) return null;
	const bucket =
		lines.length === 1 ? bucketAt(lines[0]?.buckets ?? [], hoverAt, bucketSeconds) : null;
	return (
		<span className="font-mono text-2xs text-fg-3" data-hover-reading>
			{formatClock(hoverAt)}
			{bucket === null ? "" : `  ${formatReading(bucket)}`}
		</span>
	);
}

interface PlotProps {
	type: Exclude<ChartType, "stat">;
	lines: readonly DrawnLine[];
	window: TimeRange;
	bucketSeconds: number;
	height: number;
	mini?: boolean;
	/** 只画一条线时的颜色（默认按序列）。 */
	color?: string;
	/** 标题栏显示的最新值：纵轴上限与它相同时不再在绘图区里重复一遍。 */
	latestText?: string;
}

/** 纵轴范围（含每个桶的最小、最大值）：柱状、面积与迷你趋势从 0 起；上方留 12%。 */
const yScale = (type: PlotProps["type"], lines: readonly DrawnLine[], mini?: boolean) =>
	valueExtent(lines, type !== "line" || !!mini);

/**
 * SVG 绘图区：viewBox 宽 300，按容器宽度拉伸（线宽不随之缩放）。
 * 鼠标在绘图区上、画了多条线时，悬停提示列出每条线在那一刻的值。
 */
function Plot(props: PlotProps) {
	const { type, lines, window, height, mini, bucketSeconds, latestText } = props;
	const actions = useMonitorActions();
	const [pointerInside, setPointerInside] = useState(false);
	const scale = useMemo(() => yScale(type, lines, mini), [type, lines, mini]);
	const maxText = formatMetric(scale.max);
	return (
		// span：迷你趋势放在分组标题的按钮里，按钮里只能有短语内容。
		<span className="relative block">
			<svg
				role="img"
				aria-label="图表绘图区"
				data-plot
				viewBox={`0 0 ${W} ${height}`}
				preserveAspectRatio="none"
				className={cn("mt-1 block w-full cursor-crosshair", mini && "mt-0")}
				style={{ height }}
				onPointerMove={(e) => {
					const rect = e.currentTarget.getBoundingClientRect();
					if (rect.width === 0) return;
					const f = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
					actions.hover(window.start + f * (window.end - window.start));
				}}
				onPointerEnter={() => setPointerInside(true)}
				onPointerLeave={() => {
					setPointerInside(false);
					actions.hover(null);
				}}
			>
				<Paths {...props} scale={scale} />
				<Cursor window={window} height={height} />
			</svg>
			{!mini && maxText !== latestText && (
				<span
					data-axis-max
					className="pointer-events-none absolute top-0.5 right-0.5 rounded-sm bg-bg px-0.5 font-mono text-2xs text-fg-3"
				>
					{maxText}
				</span>
			)}
			{pointerInside && !mini && (
				<HoverValues lines={lines} window={window} bucketSeconds={bucketSeconds} />
			)}
		</span>
	);
}

const Paths = memo(function Paths({
	type,
	lines,
	window,
	bucketSeconds,
	height: H,
	mini,
	color,
	scale,
}: PlotProps & { scale: ReturnType<typeof yScale> }) {
	const span = bucketSeconds * 1000;
	const { min, top } = scale;
	// 桶画在它覆盖的时段的中点（每秒一个桶时就是那一秒）。
	const X = (b: ChartBucket) =>
		((bucketStartMs(b) + span / 2 - window.start) / (window.end - window.start)) * W;
	const Y = (v: number) => H - 2 - ((v - min) / (top - min)) * (H - 6);
	return (
		<>
			{!mini &&
				[0.25, 0.5, 0.75].map((f) => (
					<line
						key={f}
						x1={0}
						x2={W}
						y1={H * f}
						y2={H * f}
						stroke="var(--chart-grid)"
						vectorEffect="non-scaling-stroke"
					/>
				))}
			{lines.map((line) => {
				const stroke = color ?? line.color;
				if (line.buckets.length === 0) return null;
				if (type === "bar" && !mini) {
					const bw = Math.max(1, (span / (window.end - window.start)) * W * 0.7);
					// 柱高是最新值；桶里有范围时叠一条最小–最大的细线（尖峰不被合并掉）。
					return (
						<g key={line.key} fill={stroke} data-series={line.name}>
							{line.buckets.map((b) => (
								<g key={b.time}>
									<rect
										x={X(b) - bw / 2}
										y={Y(b.last)}
										width={bw}
										height={Math.max(0, H - 2 - Y(b.last))}
										opacity={0.75}
									/>
									{b.min < b.max && (
										<line
											data-range
											x1={X(b)}
											x2={X(b)}
											y1={Y(b.max)}
											y2={Y(b.min)}
											stroke={stroke}
											vectorEffect="non-scaling-stroke"
										/>
									)}
								</g>
							))}
						</g>
					);
				}
				// 只有一个桶时画一小段横线（单个点看不见）。
				const pts =
					line.buckets.length === 1
						? [-1.5, 1.5].map((dx) => [
								X(line.buckets[0] as ChartBucket) + dx,
								Y(line.buckets[0]?.last ?? 0),
							])
						: line.buckets.map((b) => [X(b), Y(b.last)]);
				const d = `M${pts.map(([x, y]) => `${x?.toFixed(1)} ${y?.toFixed(1)}`).join(" L")}`;
				const first = line.buckets[0] as ChartBucket;
				const last = line.buckets.at(-1) as ChartBucket;
				const band = !mini && hasSpread(line.buckets) && line.buckets.length > 1;
				return (
					<g key={line.key} data-series={line.name}>
						{band && (
							// 最小–最大包络：降采样合并掉的短时尖峰仍然看得到（故事 14）。
							<path
								data-envelope
								d={`M${envelopePoints(line.buckets, X, Y)
									.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`)
									.join(" L")}Z`}
								fill={stroke}
								opacity={0.18}
							/>
						)}
						{(type === "area" || mini) && (
							<path
								d={`${d} L${X(last).toFixed(1)} ${H} L${X(first).toFixed(1)} ${H}Z`}
								fill={stroke}
								opacity={0.13}
							/>
						)}
						<path
							d={d}
							fill="none"
							stroke={stroke}
							strokeWidth={1.4}
							vectorEffect="non-scaling-stroke"
						/>
					</g>
				);
			})}
		</>
	);
});

/**
 * 绘图区的悬停提示：悬停的那个点的控制面时间和 Agent 时间（charts.ts 的 bucketTimes；平台自带图表没有），
 * 画了多条线时再列出每条显示中的线在悬停时刻的值，按值从大到小，那一刻没有点的线不列出
 * （只有一条线时值在标题栏里，见 HoverReading）。提示贴着竖线，悬停在右半边时放到竖线左侧。
 */
function HoverValues({
	lines,
	window,
	bucketSeconds,
}: {
	lines: readonly DrawnLine[];
	window: TimeRange;
	bucketSeconds: number;
}) {
	const hoverAt = useMonitor((s) => s.hoverAt);
	if (hoverAt === null || hoverAt < window.start || hoverAt > window.end) return null;
	const rows = lines
		.flatMap((line) => {
			const bucket = bucketAt(line.buckets, hoverAt, bucketSeconds);
			return bucket ? [{ line, bucket }] : [];
		})
		.sort((a, b) => b.bucket.last - a.bucket.last);
	// 一张图表的线来自同一个任务：同一时刻各条线的两种时间相同，取第一条有 Agent 时间的。
	const times = rows.map((r) => bucketTimes(r.bucket)).find((t) => t !== null);
	const values = lines.length > 1 ? rows : [];
	if (!times && values.length === 0) return null;
	const f = (hoverAt - window.start) / (window.end - window.start);
	const side =
		f > 0.5 ? { right: `calc(${(1 - f) * 100}% + 8px)` } : { left: `calc(${f * 100}% + 8px)` };
	return (
		<span
			data-hover-values
			className="pointer-events-none absolute top-1 z-3 flex max-w-60 flex-col rounded-md border border-border-strong bg-raised px-2 py-1 text-xs whitespace-nowrap shadow-pop"
			style={side}
		>
			{times && (
				<span className="flex flex-col font-mono text-fg-3">
					<span data-hover-time>控制面时间 {times.controlPlane}</span>
					<span data-hover-agent-time>Agent 时间 {times.agent}</span>
				</span>
			)}
			{values.map(({ line, bucket }) => (
				<span key={line.key} data-hover-value className="flex items-center gap-1.5">
					<i
						aria-hidden
						className="inline-block h-0.5 w-2.5 flex-none"
						style={{ background: line.color }}
					/>
					<span className="min-w-0 truncate text-fg-2">{line.name}</span>
					<span className="ml-auto pl-2 font-mono text-fg-1">{formatReading(bucket)}</span>
				</span>
			))}
		</span>
	);
}

/** 悬停竖线与日志标记（订阅共享状态，只有它们随鼠标重新渲染）。 */
function Cursor({ window, height }: { window: TimeRange; height: number }) {
	const hoverAt = useMonitor((s) => s.hoverAt);
	const marker = useMonitor((s) => s.marker);
	const x = (t: number) => ((t - window.start) / (window.end - window.start)) * W;
	const inside = (t: number | null): t is number =>
		t !== null && t >= window.start && t <= window.end;
	return (
		<>
			{inside(marker) && (
				<line
					data-chart-marker
					x1={x(marker)}
					x2={x(marker)}
					y1={0}
					y2={height}
					stroke="var(--warn)"
					strokeDasharray="3 3"
					vectorEffect="non-scaling-stroke"
				/>
			)}
			{inside(hoverAt) && (
				<line
					data-chart-hover
					x1={x(hoverAt)}
					x2={x(hoverAt)}
					y1={0}
					y2={height}
					stroke="var(--fg-1)"
					strokeOpacity={0.6}
					vectorEffect="non-scaling-stroke"
				/>
			)}
		</>
	);
}
