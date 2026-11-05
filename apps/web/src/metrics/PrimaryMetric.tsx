import type { CatalogNode, MetricBucket } from "@sfly/schema";
import { cn } from "cn";
import { useMemo } from "react";
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

/** 迷你趋势的颜色随节点状态：执行中青色、失败红色，其余中性灰。 */
export function metricAccent(status: string | undefined): string {
	if (status === "running" || status === "dispatched") return "var(--signal)";
	if (status === "failed") return "var(--danger)";
	return "var(--fg-3)";
}

const W = 300;

/**
 * 迷你趋势（原型 spark）：面积 + 折线，纵轴从 0 起、上方留 12%，横轴按桶的时间（画在桶覆盖时段的中点）。
 * 宽高由 className 决定（SVG 按容器拉伸，线宽不缩放）；少于两个桶时不画。
 */
export function Sparkline({
	buckets,
	bucketSeconds,
	color,
	className,
}: {
	buckets: readonly MetricBucket[];
	bucketSeconds: number;
	color: string;
	className?: string;
}) {
	const H = 20;
	const path = useMemo(() => {
		const first = buckets[0];
		const end = buckets.at(-1);
		if (!first || !end || buckets.length < 2) return null;
		const span = bucketSeconds * 1000;
		const start = Date.parse(first.time);
		const stop = Math.max(Date.parse(end.time) + span, start + 1000);
		const values = buckets.map((b) => b.last);
		const min = Math.min(0, ...values);
		let max = Math.max(...values);
		if (max - min < 1e-9) max = min + 1;
		const top = max + (max - min) * 0.12;
		const X = (b: MetricBucket) => ((Date.parse(b.time) + span / 2 - start) / (stop - start)) * W;
		const Y = (v: number) => H - 2 - ((v - min) / (top - min)) * (H - 6);
		const line = `M${buckets.map((b) => `${X(b).toFixed(1)} ${Y(b.last).toFixed(1)}`).join(" L")}`;
		return {
			line,
			area: `${line} L${X(end).toFixed(1)} ${H} L${X(first).toFixed(1)} ${H}Z`,
		};
	}, [buckets, bucketSeconds]);
	if (!path) return null;
	return (
		<svg
			aria-hidden="true"
			data-sparkline
			viewBox={`0 0 ${W} ${H}`}
			preserveAspectRatio="none"
			className={cn("block", className)}
		>
			<path d={path.area} fill={color} opacity={0.13} />
			<path
				d={path.line}
				fill="none"
				stroke={color}
				strokeWidth={1.4}
				vectorEffect="non-scaling-stroke"
			/>
		</svg>
	);
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
	accent,
	variant,
	className,
}: {
	data: PrimaryMetricData;
	accent: string;
	variant: "chip" | "inline" | "block";
	className?: string;
}) {
	const { name, unit, last, buckets, bucketSeconds } = data;
	const spark = (sparkClass: string) => (
		<Sparkline
			buckets={buckets}
			bucketSeconds={bucketSeconds}
			color={accent}
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
				{spark("h-4 w-14 flex-none")}
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
				<span className="min-w-0 truncate">
					<span className="text-fg-3">{name}</span>{" "}
					<b className="font-mono font-semibold text-fg-1">{valueText(last)}</b>
					{unit && <span className="text-fg-3"> {unit}</span>}
				</span>
				{spark("ml-auto h-3.5 w-13.5 flex-none")}
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
			{spark("h-8.5 min-w-0 flex-1")}
		</div>
	);
}

/**
 * 运行里一个节点的主指标（自己查询序列）；节点类型没有主指标时渲染 fallback。
 * status 是节点状态（决定趋势颜色、序列是否还会变化）。
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
	const finished = !ACTIVE.has(status);
	const data = usePrimaryMetric(runId, entry, { finished, poll });
	if (!data) return fallback;
	return (
		<PrimaryMetric
			data={data}
			accent={metricAccent(status)}
			variant={variant}
			className={className}
		/>
	);
}

/** 尝试还会继续上报指标的节点状态。 */
const ACTIVE = new Set(["dispatched", "running"]);
