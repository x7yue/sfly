import type { RunFocusItem } from "@sfly/schema";
import { cn } from "cn";
import { useMemo } from "react";
import { nodeStatusView, StatusDot } from "#/components/status";
import { UntrustedText } from "#/components/untrusted-text";
import { FOCUS, hiddenSeriesLabel, MONITOR_VIEW_LABEL, viewInLabel } from "#/lib/copy";
import { attemptWindow } from "#/monitor/charts";
import { Button } from "@/components/ui/button";
import { AnomalyNote } from "./AnomalyNote";
import { FocusPlot } from "./FocusPlot";
import { FocusValue } from "./FocusValue";
import { readingFoot, readingLabel, readingState, sourceNodeName, staleText } from "./focus-format";

/** 绘图区的高度（px）；宽度取容器的实际宽度。 */
const PLOT_HEIGHT = 156;

/**
 * 一个图表类关注项（折线、面积、柱状）的卡片：状态形状和名称、最新值、来源节点和多久前、按容器的实际尺寸画的图、
 * 序列多于一条时的图例，以及「在详情里查看」。图的横轴是来源节点这次尝试的开始到结束（还没结束就到读数生成的时刻），
 * 纵轴从 0 起。序列多于 10 条时只画平均值最高的那些（`shownSeries`），图例写明还有多少条。
 * 有异常时「来源节点 · 多久前」一行换成琥珀三角、原因和来源节点；没有新数据时曲线停在最后一个点，之后到现在画斜线，
 * 写明「已 2m 10s 无新数据」，图的可访问名称里也说明。
 */
export function FocusChart({
	item,
	generatedAt,
	onOpen,
	located = false,
	runEnded = false,
}: {
	item: RunFocusItem;
	generatedAt: string;
	/** 运行已经结束：一直待执行的来源节点写「这次运行没有执行」。 */
	runEnded?: boolean;
	/** 在详情里查看来源节点。 */
	onOpen: () => void;
	/** 从别处（控制台运行块的读数）进来定位到这个节点：描边换成中性高亮，`aria-current="location"`。 */
	located?: boolean;
}) {
	const { started_at, ended_at } = item.source;
	const axis = useMemo(
		() => attemptWindow({ started_at, ended_at }, Date.parse(generatedAt)),
		[started_at, ended_at, generatedAt],
	);
	const titleId = `focus-chart-${item.position}`;
	const state = readingState(item, generatedAt, runEnded);

	return (
		<article
			aria-labelledby={titleId}
			data-focus-chart={item.chart}
			aria-current={located ? "location" : undefined}
			className={cn(
				"flex min-w-0 flex-col gap-1 rounded-lg border border-border-soft bg-surface px-3.5 pt-3 pb-2.5",
				located && "border-selected",
			)}
		>
			<header className="flex items-baseline gap-2">
				<StatusDot kind={nodeStatusView(item.source.status).kind} className="self-center" />
				<h3 id={titleId} className="m-0 min-w-0 text-sm font-semibold wrap-anywhere text-fg-1">
					<UntrustedText text={item.title} />
				</h3>
				{!item.unavailable && <FocusValue item={item} className="ml-auto flex-none truncate" />}
			</header>
			{item.anomaly ? (
				<AnomalyNote item={item} generatedAt={generatedAt} suffix={` · ${sourceNodeName(item)}`} />
			) : (
				<p className="m-0 font-mono text-xs text-fg-3">
					{readingFoot(item, generatedAt, runEnded)}
				</p>
			)}
			{item.unavailable ? (
				<p className="m-0 grid h-24 place-items-center text-xs text-fg-3">
					<UntrustedText dir="ltr" text={FOCUS.chartMissing(item.chart)} />
				</p>
			) : (
				<FocusPlot
					series={item.series}
					type={item.chart_type}
					metrics={item.metrics}
					axis={axis}
					bucketSeconds={item.bucket_seconds}
					staleSince={item.stale_since}
					height={PLOT_HEIGHT}
					label={readingLabel(item, generatedAt, runEnded)}
					empty={state.kind === "empty" ? state.text : null}
					gapText={staleText(item, generatedAt)}
					hiddenNote={hiddenSeriesLabel.inView}
				/>
			)}
			<footer className="mt-auto flex justify-end pt-1">
				<Button variant="link" onClick={onOpen} className="text-xs text-fg-2">
					{viewInLabel(MONITOR_VIEW_LABEL.detail, sourceNodeName(item))}
				</Button>
			</footer>
		</article>
	);
}
