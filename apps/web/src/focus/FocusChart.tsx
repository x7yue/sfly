import { focusSeriesName, type RunFocusItem } from "@sfly/schema";
import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { nodeStatusView, StatusDot } from "#/components/status";
import { FOCUS, LIST_LABEL, MONITOR_VIEW_LABEL } from "#/lib/copy";
import type { ShownPick } from "#/monitor/charts";
import { seriesColor, seriesDash } from "#/monitor/MetricChart";
import { Button } from "@/components/ui/button";
import { AnomalyNote } from "./AnomalyNote";
import { FocusValue } from "./FocusValue";
import { PLOT_MARGIN, plotChart, shownSeries } from "./focus-chart";
import {
	anomalyText,
	readingFoot,
	readingLabel,
	readingState,
	sourceNodeName,
} from "./focus-format";

/** 绘图区的高度（px）；宽度取容器的实际宽度。 */
const PLOT_HEIGHT = 156;

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
 * 一个图表类关注项（折线、面积、柱状）的卡片：状态形状和名称、最新值、来源节点和多久前、按容器的实际尺寸画的图、
 * 序列多于一条时的图例，以及「在详情里打开」。图的横轴是来源节点这次尝试的开始到结束（还没结束就到读数生成的时刻），
 * 纵轴从 0 起。序列多于 10 条时只画平均值最高的那些（`shownSeries`），图例写明还有多少条。
 * 有异常时「来源节点 · 多久前」一行换成琥珀三角、原因和来源节点；没有新数据时曲线停在最后一个点，之后到现在画斜线，
 * 写明「已 2m 10s 无新数据」，图的可访问名称里也说明。
 */
export function FocusChart({
	item,
	generatedAt,
	onOpen,
}: {
	item: RunFocusItem;
	generatedAt: string;
	/** 在详情里打开来源节点。 */
	onOpen: () => void;
}) {
	const [plotRef, width] = useElementWidth<HTMLDivElement>();
	// 画哪些序列只在第一次和出现新序列时挑：读数每 2 秒刷新，平均值接近的序列不来回换。
	const [picked, setPicked] = useState<ShownPick | undefined>(undefined);
	const { series, hidden, pick } = useMemo(
		() => shownSeries(item.series, picked),
		[item.series, picked],
	);
	if (pick !== picked) setPicked(pick);
	const started = item.source.started_at;
	const axis = useMemo(() => {
		if (started === null) return null;
		const start = Date.parse(started);
		const end = Date.parse(item.source.ended_at ?? generatedAt);
		return { start, end: Math.max(end, start + 1000) };
	}, [started, item.source.ended_at, generatedAt]);
	const staleSince = item.anomaly?.kind === "stale" && item.last_at ? item.last_at : null;
	const plot = useMemo(
		() =>
			axis && width > 0
				? plotChart(
						series,
						axis,
						item.bucket_seconds,
						{ width, height: PLOT_HEIGHT },
						staleSince === null ? undefined : Date.parse(staleSince),
					)
				: null,
		[axis, width, series, item.bucket_seconds, staleSince],
	);
	const titleId = `focus-chart-${item.position}`;
	const hatchId = useId();
	const state = readingState(item, generatedAt);
	const gap = plot?.gap ?? null;
	const gapText = gap && anomalyText(item, generatedAt);

	return (
		<article
			aria-labelledby={titleId}
			data-focus-chart={item.chart}
			className="flex min-w-0 flex-col gap-1 rounded-lg border border-border-soft bg-surface px-3.5 pt-3 pb-2.5"
		>
			<header className="flex items-baseline gap-2">
				<StatusDot kind={nodeStatusView(item.source.status).kind} className="self-center" />
				<h3 id={titleId} className="m-0 min-w-0 text-sm font-semibold wrap-anywhere text-fg-1">
					{item.title}
				</h3>
				{!item.unavailable && <FocusValue item={item} className="ml-auto flex-none truncate" />}
			</header>
			{item.anomaly ? (
				<AnomalyNote item={item} generatedAt={generatedAt} suffix={` · ${sourceNodeName(item)}`} />
			) : (
				<p className="m-0 font-mono text-xs text-fg-3">{readingFoot(item, generatedAt)}</p>
			)}
			{item.unavailable ? (
				<p className="m-0 grid h-24 place-items-center text-xs text-fg-3">
					{FOCUS.chartMissing(item.chart)}
				</p>
			) : (
				<div ref={plotRef} className="relative" style={{ height: PLOT_HEIGHT }}>
					{plot && (
						<svg
							role="img"
							aria-label={`${readingLabel(item, generatedAt)}${gap ? "，曲线停在最后一个点" : ""}`}
							width={width}
							height={PLOT_HEIGHT}
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
										height={PLOT_HEIGHT - PLOT_MARGIN.top - PLOT_MARGIN.bottom}
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
									y={PLOT_HEIGHT - 4}
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
										type={item.chart_type}
										line={line}
										color={seriesColor(slot)}
										dash={seriesDash(slot)}
										baseline={plot.yTicks[0]?.y ?? 0}
									/>
								);
							})}
						</svg>
					)}
					{state.kind === "empty" && (
						<span className="absolute inset-0 grid place-items-center pb-5 pl-11 text-xs text-fg-3">
							{state.text}
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
			)}
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
							{focusSeriesName(item, s)}
						</li>
					))}
					{hidden > 0 && (
						<li>
							另有 {hidden} 条序列在{MONITOR_VIEW_LABEL.detail}里查看
						</li>
					)}
				</ul>
			)}
			<footer className="mt-auto flex justify-end pt-1">
				<Button variant="link" onClick={onOpen} className="text-xs text-fg-2">
					在{MONITOR_VIEW_LABEL.detail}里打开 {sourceNodeName(item)}
				</Button>
			</footer>
		</article>
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
