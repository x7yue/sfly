import type { MetricBucket } from "@sfly/schema";
import { cn } from "cn";
import { memo, useMemo } from "react";
import { formatClock } from "#/lib/format";
import { Badge } from "@/components/ui/badge";
import { valueAt } from "./charts";
import { useMonitor, useMonitorActions } from "./monitor-state";
import type { TimeRange } from "./timeline";

/**
 * 一张指标图表（原型 chartHTML / plotSVG）：折线、面积、柱状、数值卡四种类型，多序列时显示图例。
 * 横轴由调用方给出（节点实际运行的时段与时间线范围的交集，见 charts.ts 的 chartWindow）。
 * 悬停时把时刻写进共享状态（时间线和其他图表同步显示竖线与读数），日志标记画成琥珀色虚线。
 */

export type ChartType = "line" | "area" | "bar" | "stat";

export interface ChartLine {
	name: string;
	buckets: readonly MetricBucket[];
}

/** 多序列的线色（token chart-1 … chart-4，按序循环）。 */
export const SERIES_COLORS = [
	"var(--chart-1)",
	"var(--chart-2)",
	"var(--chart-3)",
	"var(--chart-4)",
];
const seriesColor = (i: number) => SERIES_COLORS[i % SERIES_COLORS.length] as string;

/** 指标值：`1.2M`、`12.3k`、`812`、`3.14`。 */
export function formatMetric(value: number): string {
	const abs = Math.abs(value);
	if (abs >= 1e6) return `${(value / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
	if (abs >= 1e4) return `${(value / 1e3).toFixed(abs >= 1e5 ? 0 : 1)}k`;
	if (Number.isInteger(value)) return String(value);
	return abs >= 100 ? value.toFixed(0) : abs >= 10 ? value.toFixed(1) : value.toFixed(2);
}

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
	accent,
	truncated,
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
	/** 数值卡迷你趋势的颜色（随节点状态）。 */
	accent?: string;
	truncated?: boolean;
	footnote?: React.ReactNode;
}) {
	const span = bucketSeconds * 1000;
	const visible = useMemo(
		() =>
			window
				? lines.map((l) => ({
						...l,
						buckets: l.buckets.filter((b) => {
							const t = Date.parse(b.time);
							return t + span > window.start && t <= window.end;
						}),
					}))
				: [],
		[lines, window, span],
	);
	const has = visible.some((l) => l.buckets.length > 0);
	const latest = visible[0]?.buckets.at(-1)?.last;
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
				{shown && type !== "stat" && (
					<HoverReading lines={visible} window={shown} bucketSeconds={bucketSeconds} />
				)}
				{type !== "stat" && (
					<span className="ml-auto font-mono text-sm font-semibold text-fg-1" data-latest>
						{latest === undefined ? "—" : formatMetric(latest)}
						<small className="ml-0.5 text-2xs font-normal text-fg-3">{unit}</small>
					</span>
				)}
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
						lines={visible.slice(0, 1)}
						window={shown}
						bucketSeconds={bucketSeconds}
						height={30}
						mini
						color={accent}
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
					/>
					<div className="mt-0.5 flex gap-2.5 text-2xs text-fg-3">
						{visible.length > 1 &&
							visible.map((l, i) => (
								<span key={l.name} className="inline-flex items-center gap-1">
									<i
										aria-hidden
										className="inline-block h-0.5 w-2.5"
										style={{ background: seriesColor(i) }}
									/>
									{l.name}
								</span>
							))}
						<span className="ml-auto font-mono" data-window>
							{formatClock(shown.start)} – {formatClock(shown.end)}
						</span>
					</div>
				</>
			)}
			{footnote}
		</figure>
	);
}

/** 悬停时刻与第一条序列在那一刻的值。 */
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
	const value = valueAt(lines[0]?.buckets ?? [], hoverAt, bucketSeconds);
	return (
		<span className="font-mono text-2xs text-fg-3" data-hover-reading>
			{formatClock(hoverAt)}
			{value === null ? "" : `  ${formatMetric(value)}`}
		</span>
	);
}

interface PlotProps {
	type: Exclude<ChartType, "stat">;
	lines: readonly ChartLine[];
	window: TimeRange;
	bucketSeconds: number;
	height: number;
	mini?: boolean;
	/** 只画一条线时的颜色（默认按序列）。 */
	color?: string;
}

/** 纵轴范围：柱状、面积与迷你趋势从 0 起；上方留 12%。 */
function yScale(type: PlotProps["type"], lines: readonly ChartLine[], mini?: boolean) {
	const values = lines.flatMap((l) => l.buckets.map((b) => b.last));
	let min = Math.min(...values);
	let max = Math.max(...values);
	if (type !== "line" || mini) min = Math.min(0, min);
	if (max - min < 1e-9) max = min + 1;
	return { min, max, top: max + (max - min) * 0.12 };
}

/** SVG 绘图区：viewBox 宽 300，按容器宽度拉伸（线宽不随之缩放）。 */
export function Plot(props: PlotProps) {
	const { type, lines, window, height, mini } = props;
	const actions = useMonitorActions();
	const scale = useMemo(() => yScale(type, lines, mini), [type, lines, mini]);
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
				onPointerLeave={() => actions.hover(null)}
			>
				<Paths {...props} scale={scale} />
				<Cursor window={window} height={height} />
			</svg>
			{!mini && (
				<span className="pointer-events-none absolute top-0.5 right-0.5 font-mono text-2xs text-fg-3 opacity-70">
					{formatMetric(scale.max)}
				</span>
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
	const X = (b: MetricBucket) =>
		((Date.parse(b.time) + span / 2 - window.start) / (window.end - window.start)) * W;
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
			{lines.map((line, i) => {
				const stroke = color ?? seriesColor(i);
				if (line.buckets.length === 0) return null;
				if (type === "bar" && !mini) {
					const bw = Math.max(1, (span / (window.end - window.start)) * W * 0.7);
					return (
						<g key={line.name} fill={stroke} opacity={0.75} data-series={line.name}>
							{line.buckets.map((b) => (
								<rect
									key={b.time}
									x={X(b) - bw / 2}
									y={Y(b.last)}
									width={bw}
									height={Math.max(0, H - 2 - Y(b.last))}
								/>
							))}
						</g>
					);
				}
				// 只有一个桶时画一小段横线（单个点看不见）。
				const pts =
					line.buckets.length === 1
						? [-1.5, 1.5].map((dx) => [
								X(line.buckets[0] as MetricBucket) + dx,
								Y(line.buckets[0]?.last ?? 0),
							])
						: line.buckets.map((b) => [X(b), Y(b.last)]);
				const d = `M${pts.map(([x, y]) => `${x?.toFixed(1)} ${y?.toFixed(1)}`).join(" L")}`;
				const first = line.buckets[0] as MetricBucket;
				const last = line.buckets.at(-1) as MetricBucket;
				return (
					<g key={line.name} data-series={line.name}>
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
