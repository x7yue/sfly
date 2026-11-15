import type { FocusSeries, RunFocusItem } from "@sfly/schema";
import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { LIST_LABEL, MONITOR_VIEW_LABEL } from "#/lib/copy";
import type { ShownPick } from "#/monitor/charts";
import { seriesColor, seriesDash } from "#/monitor/MetricChart";
import { PLOT_MARGIN, type PlotWindow, plotChart, shownSeries } from "./focus-chart";
import { focusSeriesName } from "./focus-format";

/** 元素的实际宽度（px）：量一次，之后随容器尺寸变化更新；还没量到时为 0。 */
function useElementWidth<E extends HTMLElement>() {
	const ref = useRef<E>(null);
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		setWidth(Math.round(el.clientWidth));
		const observer = new ResizeObserver(() => setWidth(Math.round(el.clientWidth)));
		observer.observe(el);
		return () => observer.disconnect();
	}, []);
	return [ref, width] as const;
}

/**
 * 一张图表（折线、面积、柱状）的绘图区和图例：按容器的实际宽度画（SVG 用量出来的像素宽度，文字不被拉伸），纵轴从 0 起，
 * 横轴是 `axis`（来源节点这次尝试的开始到结束，还没结束就到现在）。序列多于 10 条时只画平均值最高的那些（`shownSeries`），
 * 挑好以后保持不变，只在出现新序列时重新挑；图例写明还有多少条在详情里。给了 `staleSince`（没有新数据时最后一个点的时间）时
 * 曲线停在最后一个点，之后到横轴末端画斜线，旁边写 `gapText`，图的可访问名称后面加「曲线停在最后一个点」。
 * 概览的图表卡片（`FocusChart`）和画布运行状态检查器里的图表共用。
 */
export function FocusPlot({
	series: all,
	type,
	metrics,
	axis,
	bucketSeconds,
	staleSince,
	height,
	label,
	empty,
	gapText,
}: {
	series: readonly FocusSeries[];
	type: RunFocusItem["chart_type"];
	/** 这张图表读的指标：图例里序列的名字按它写。 */
	metrics: RunFocusItem["metrics"];
	/** 横轴；还没开始执行时为 null，只写 `empty`。 */
	axis: PlotWindow | null;
	bucketSeconds: number;
	staleSince: string | null;
	height: number;
	/** 图的可访问名称（名称、最新值、来源节点和状态）。 */
	label: string;
	/** 没有值时盖在绘图区上的原因；有值时为 null。 */
	empty: string | null;
	gapText: string | null;
}) {
	const [plotRef, width] = useElementWidth<HTMLDivElement>();
	// 画哪些序列只在第一次和出现新序列时挑：读数每 2 秒刷新，平均值接近的序列不来回换。
	const [picked, setPicked] = useState<ShownPick | undefined>(undefined);
	const { series, hidden, pick } = useMemo(() => shownSeries(all, picked), [all, picked]);
	if (pick !== picked) setPicked(pick);
	const plot = useMemo(
		() =>
			axis && width > 0
				? plotChart(
						series,
						axis,
						bucketSeconds,
						{ width, height },
						staleSince === null ? undefined : Date.parse(staleSince),
					)
				: null,
		[axis, width, height, series, bucketSeconds, staleSince],
	);
	const hatchId = useId();
	const gap = plot?.gap ?? null;
	return (
		<>
			<div ref={plotRef} className="relative" style={{ height }}>
				{plot && (
					<svg
						role="img"
						aria-label={`${label}${gap ? "，曲线停在最后一个点" : ""}`}
						width={width}
						height={height}
						className="block"
					>
						{gap && (
							<>
								<defs>
									<pattern
										id={hatchId}
										width={6}
										height={6}
										patternUnits="userSpaceOnUse"
										patternTransform="rotate(45)"
									>
										<rect width={1.5} height={6} fill="var(--border-strong)" />
									</pattern>
								</defs>
								<rect
									data-stale-gap
									x={gap.x}
									y={PLOT_MARGIN.top}
									width={gap.width}
									height={height - PLOT_MARGIN.top - PLOT_MARGIN.bottom}
									fill={`url(#${CSS.escape(hatchId)})`}
								/>
							</>
						)}
						{plot.yTicks.map((tick) => (
							<g key={tick.label}>
								<line
									x1={PLOT_MARGIN.left}
									x2={width - PLOT_MARGIN.right}
									y1={tick.y}
									y2={tick.y}
									stroke="var(--chart-grid)"
								/>
								<text
									x={PLOT_MARGIN.left - 6}
									y={tick.y + 4}
									textAnchor="end"
									className="fill-fg-3 font-mono text-2xs"
								>
									{tick.label}
								</text>
							</g>
						))}
						{plot.xTicks.map((tick, i) => (
							<text
								key={tick.x}
								x={tick.x}
								y={height - 4}
								textAnchor={i === 0 ? "start" : i === plot.xTicks.length - 1 ? "end" : "middle"}
								className="fill-fg-3 font-mono text-2xs"
							>
								{tick.label}
							</text>
						))}
						{plot.lines.map((line, i) => {
							const slot = series[i]?.slot ?? i;
							return (
								<PlotLineShape
									key={line.key}
									type={type}
									line={line}
									color={seriesColor(slot)}
									dash={seriesDash(slot)}
									baseline={plot.yTicks[0]?.y ?? 0}
								/>
							);
						})}
					</svg>
				)}
				{empty !== null && (
					<span className="absolute inset-0 grid place-items-center pb-5 pl-11 text-xs text-fg-3">
						{empty}
					</span>
				)}
				{gap && gapText && (
					<span
						aria-hidden="true"
						className="absolute rounded-sm bg-surface px-1 text-xs whitespace-nowrap text-warn-fg"
						style={{
							bottom: PLOT_MARGIN.bottom + 6,
							// 斜线在右半边时文字靠在它的左边，否则放进斜线里。
							...(gap.x > width / 2 ? { right: width - gap.x + 6 } : { left: gap.x + 6 }),
						}}
					>
						{gapText}
					</span>
				)}
			</div>
			{series.length > 1 && (
				<ul
					aria-label={LIST_LABEL.legend}
					className="m-0 flex list-none flex-wrap gap-x-3 gap-y-0.5 p-0 text-xs text-fg-3"
				>
					{series.map((s) => (
						<li key={s.key} className="inline-flex items-center gap-1">
							<svg aria-hidden="true" width={12} height={4} className="flex-none overflow-visible">
								<line
									x1={0}
									x2={12}
									y1={2}
									y2={2}
									stroke={seriesColor(s.slot)}
									strokeWidth={2}
									strokeDasharray={seriesDash(s.slot)}
								/>
							</svg>
							{focusSeriesName({ metrics }, s)}
						</li>
					))}
					{hidden > 0 && (
						<li>
							另有 {hidden} 条序列在{MONITOR_VIEW_LABEL.detail}里查看
						</li>
					)}
				</ul>
			)}
		</>
	);
}

function PlotLineShape({
	type,
	line,
	color,
	dash,
	baseline,
}: {
	type: RunFocusItem["chart_type"];
	line: ReturnType<typeof plotChart>["lines"][number];
	color: string;
	dash: string | undefined;
	baseline: number;
}) {
	const points = (p: ReadonlyArray<readonly [number, number]>) =>
		p.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
	if (type === "bar") {
		return (
			<g fill={color} opacity={0.75}>
				{line.bars.map((bar) => (
					<rect key={bar.x} x={bar.x} y={bar.y} width={bar.width} height={bar.height} />
				))}
			</g>
		);
	}
	const first = line.path[0];
	const last = line.path.at(-1);
	return (
		<g>
			{line.band && <polygon points={points(line.band)} fill={color} opacity={0.18} />}
			{type === "area" && first && last && (
				<polygon
					points={points([...line.path, [last[0], baseline], [first[0], baseline]])}
					fill={color}
					opacity={0.13}
				/>
			)}
			<polyline
				points={points(line.path)}
				fill="none"
				stroke={color}
				strokeWidth={1.5}
				strokeDasharray={dash}
			/>
		</g>
	);
}
