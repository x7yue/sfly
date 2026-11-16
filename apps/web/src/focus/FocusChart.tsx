import type { RunFocusItem } from "@sfly/schema";
import { useMemo } from "react";
import { nodeStatusView, StatusDot } from "#/components/status";
import { FOCUS, MONITOR_VIEW_LABEL, openInLabel } from "#/lib/copy";
import { Button } from "@/components/ui/button";
import { AnomalyNote } from "./AnomalyNote";
import { FocusPlot } from "./FocusPlot";
import { FocusValue } from "./FocusValue";
import {
	anomalyText,
	readingFoot,
	readingLabel,
	readingState,
	sourceNodeName,
} from "./focus-format";

/** 绘图区的高度（px）；宽度取容器的实际宽度。 */
const PLOT_HEIGHT = 156;

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
	const started = item.source.started_at;
	const axis = useMemo(() => {
		if (started === null) return null;
		const start = Date.parse(started);
		const end = Date.parse(item.source.ended_at ?? generatedAt);
		return { start, end: Math.max(end, start + 1000) };
	}, [started, item.source.ended_at, generatedAt]);
	const titleId = `focus-chart-${item.position}`;
	const state = readingState(item, generatedAt);

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
				<FocusPlot
					series={item.series}
					type={item.chart_type}
					metrics={item.metrics}
					axis={axis}
					bucketSeconds={item.bucket_seconds}
					staleSince={item.anomaly?.kind === "stale" ? item.last_at : null}
					height={PLOT_HEIGHT}
					label={readingLabel(item, generatedAt)}
					empty={state.kind === "empty" ? state.text : null}
					gapText={anomalyText(item, generatedAt)}
					elsewhere={MONITOR_VIEW_LABEL.detail}
				/>
			)}
			<footer className="mt-auto flex justify-end pt-1">
				<Button variant="link" onClick={onOpen} className="text-xs text-fg-2">
					{openInLabel(MONITOR_VIEW_LABEL.detail, sourceNodeName(item))}
				</Button>
			</footer>
		</article>
	);
}
