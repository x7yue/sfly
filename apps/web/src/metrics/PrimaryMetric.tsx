import {
	bucketStartMs,
	type CatalogNode,
	isOnAgentStatus,
	type MetricBucket,
} from "@sfly/schema";
import { cn } from "cn";
import { useMemo } from "react";
import { Sparkline } from "#/components/sparkline";
import { formatMetric } from "#/lib/format";
import { usePrimaryMetric } from "./use-primary-metric";

/**
 * 主指标的紧凑展示（#43）：名称、最新值、单位与迷你趋势。运行监控页的组标题、画布运行状态的节点卡片、
 * 运行抽屉摘要与运行记录的进行中卡片共用；数据见 use-primary-metric.ts。
 */

export interface PrimaryMetricData {
	name: string;
	unit: string;
	/** 最新值；还没有数据时为 undefined。 */
	last: number | undefined;
	/** 降采样后的桶（按时间升序），画迷你趋势。 */
	buckets: readonly MetricBucket[];
	bucketSeconds: number;
}

/**
 * 迷你趋势的线色：图表线色 chart-1（docs/DESIGN-SYSTEM.md §2.4，状态色只用于节点状态），
 * 节点状态由旁边的状态徽标表达，不随状态变色。
 */
const METRIC_LINE = "var(--chart-1)";

/**
 * 主指标的迷你趋势：桶的最新值，横轴按桶的时间（画在桶覆盖时段的中点），带面积（components/sparkline）。
 */
function MetricSparkline({
	buckets,
	bucketSeconds,
	color,
	height,
	className,
}: {
	buckets: readonly MetricBucket[];
	bucketSeconds: number;
	color: string;
	height: number;
	className?: string;
}) {
	const shape = useMemo(() => {
		const first = buckets[0];
		const end = buckets.at(-1);
		if (!first || !end) return null;
		const span = bucketSeconds * 1000;
		const start = bucketStartMs(first);
		const stop = Math.max(bucketStartMs(end) + span, start + 1000);
		return {
			values: buckets.map((b) => b.last),
			xs: buckets.map((b) => bucketStartMs(b) + span / 2),
			domain: [start, stop] as const,
		};
	}, [buckets, bucketSeconds]);
	if (!shape) return null;
	return <Sparkline {...shape} color={color} area height={height} className={className} />;
}

const valueText = (last: number | undefined) => (last === undefined ? "—" : formatMetric(last));

/**
 * 主指标。variant：
 * - `chip`：运行监控页组标题里的小块（底色、圆角）；
 * - `inline`：画布节点卡片的指标槽、运行记录卡片的当前节点行，趋势靠右；
 * - `block`：运行抽屉摘要里的大号数值 + 宽趋势。
 */
export function PrimaryMetric({
	data,
	variant,
	className,
}: {
	data: PrimaryMetricData;
	variant: "chip" | "inline" | "block";
	className?: string;
}) {
	const { name, unit, last, buckets, bucketSeconds } = data;
	const spark = (height: number, sparkClass: string) => (
		<MetricSparkline
			buckets={buckets}
			bucketSeconds={bucketSeconds}
			color={METRIC_LINE}
			height={height}
			className={sparkClass}
		/>
	);
	if (variant === "chip") {
		return (
			<span
				title={`主指标：${name}`}
				data-primary-metric={name}
				className={cn(
					"ml-2 inline-flex h-5.5 flex-none items-center gap-1.5 rounded-md bg-sunk px-2 text-xs",
					className,
				)}
			>
				<span className="text-fg-3">{name}</span>
				<b className="font-mono font-semibold">{valueText(last)}</b>
				{unit && <span className="text-fg-3">{unit}</span>}
				{spark(16, "w-14 flex-none")}
			</span>
		);
	}
	if (variant === "inline") {
		return (
			<span
				title={`主指标：${name}`}
				data-primary-metric={name}
				className={cn("flex min-w-0 flex-1 items-center gap-2", className)}
			>
				{/* 位置不够时只截断指标名，数值与单位总是完整显示。 */}
				<span className="flex min-w-0 items-baseline gap-1">
					<span className="min-w-0 truncate text-fg-3">{name}</span>{" "}
					<b className="flex-none font-mono font-semibold text-fg-1">{valueText(last)}</b>
					{unit && <span className="flex-none text-fg-3"> {unit}</span>}
				</span>
				{spark(14, "ml-auto w-13.5 flex-none")}
			</span>
		);
	}
	return (
		<div data-primary-metric={name} className={cn("flex items-end gap-3", className)}>
			<div className="min-w-0 flex-none">
				<div className="text-2xs text-fg-3">{name}（主指标）</div>
				<div className="font-mono text-lg font-semibold">
					{valueText(last)}
					{unit && <small className="ml-1 text-2xs font-normal text-fg-3">{unit}</small>}
				</div>
			</div>
			{spark(34, "min-w-0 flex-1")}
		</div>
	);
}

/**
 * 运行里一个节点的主指标（自己查询序列）；节点类型没有主指标、或给了 fallback 且还没有数据时渲染 fallback。
 * status 是节点状态（决定序列是否还会变化）。
 */
export function NodePrimaryMetric({
	runId,
	entry,
	status,
	poll,
	variant,
	fallback = null,
	className,
}: {
	runId: string;
	entry: CatalogNode | undefined;
	status: string;
	poll?: number;
	variant: "inline" | "block";
	fallback?: React.ReactNode;
	className?: string;
}) {
	const finished = !isOnAgentStatus(status);
	const data = usePrimaryMetric(runId, entry, { finished, poll });
	if (!data || (data.last === undefined && fallback !== null)) return fallback;
	return <PrimaryMetric data={data} variant={variant} className={className} />;
}
