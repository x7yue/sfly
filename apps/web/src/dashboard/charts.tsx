import type { DashboardChain, DashboardHour } from "@sfly/schema";
import { cn } from "cn";
import { formatHourMinute } from "#/lib/format";

/** 控制台的小图：统计卡里的迷你趋势、按小时的堆叠柱、各链进度条（原型 spark / trend / chainBars）。 */

/** 迷你趋势线（原型 spark）：线条颜色取 currentColor，由调用处的 text-* 决定。 */
export function Sparkline({ values, className }: { values: number[]; className?: string }) {
	if (values.length < 2) return null;
	const W = 200;
	const H = 26;
	const min = Math.min(...values);
	const range = Math.max(...values) - min || 1;
	const d = values
		.map((v, i) => {
			const x = (i / (values.length - 1)) * W;
			const y = H - 2 - ((v - min) / range) * (H - 4);
			return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
		})
		.join(" ");
	return (
		<svg
			aria-hidden="true"
			viewBox={`0 0 ${W} ${H}`}
			preserveAspectRatio="none"
			className={cn("mt-1.5 block h-6.5 w-full", className)}
		>
			<path
				d={d}
				fill="none"
				stroke="currentColor"
				strokeWidth={1.4}
				vectorEffect="non-scaling-stroke"
			/>
		</svg>
	);
}

const SERIES = [
	{ key: "success", label: "成功", fill: "fill-ok/60", swatch: "bg-ok/60" },
	{ key: "failed", label: "失败", fill: "fill-danger", swatch: "bg-danger" },
	{ key: "cancelled", label: "取消", fill: "fill-cancelled", swatch: "bg-cancelled" },
] as const;

export function TrendLegend() {
	return (
		<span className="flex gap-3 text-xs text-fg-3">
			{SERIES.map((s) => (
				<span key={s.key} className="inline-flex items-center gap-1.5">
					<b aria-hidden className={cn("size-2 rounded-[2px]", s.swatch)} />
					{s.label}
				</span>
			))}
		</span>
	);
}

/** 最近 24 小时按小时的堆叠柱（成功 / 失败 / 取消），下方每 6 小时一个刻度。 */
export function TrendChart({ hours }: { hours: DashboardHour[] }) {
	const W = 480;
	const H = 120;
	const slot = W / Math.max(hours.length, 1);
	const max = Math.max(1, ...hours.map((h) => h.success + h.failed + h.cancelled));
	const total = (key: (typeof SERIES)[number]["key"]) => hours.reduce((sum, h) => sum + h[key], 0);
	const summary = `最近 24 小时：${SERIES.map((s) => `${s.label} ${total(s.key)}`).join("、")}`;
	return (
		<div>
			<svg
				role="img"
				aria-label={summary}
				viewBox={`0 0 ${W} ${H}`}
				preserveAspectRatio="none"
				className="block h-35 w-full"
			>
				{[30, 60, 90].map((y) => (
					<line key={y} x1={0} x2={W} y1={y} y2={y} className="stroke-border-soft" />
				))}
				{hours.map((hour, i) => {
					let y = H - 2;
					return (
						<g key={hour.start}>
							<title>
								{`${formatHourMinute(hour.start)} 起 · 成功 ${hour.success} · 失败 ${hour.failed} · 取消 ${hour.cancelled}`}
							</title>
							{/* 透明底，悬停整列都能看到读数 */}
							<rect x={i * slot} y={0} width={slot} height={H} className="fill-transparent" />
							{SERIES.map((s) => {
								const h = (hour[s.key] / max) * (H - 16);
								if (h <= 0) return null;
								y -= h;
								return (
									<rect
										key={s.key}
										x={i * slot + 2}
										y={y}
										width={slot - 4}
										height={h}
										rx={1.5}
										className={s.fill}
									/>
								);
							})}
						</g>
					);
				})}
			</svg>
			<div aria-hidden className="flex justify-between px-0.5 font-mono text-2xs text-fg-3">
				{hours
					.filter((_, i) => i % 6 === 0)
					.map((h) => (
						<span key={h.start}>{formatHourMinute(h.start)}</span>
					))}
				<span>现在</span>
			</div>
		</div>
	);
}

/** 节点状态 → 进度条的段（原型 .bars b）；排队与待执行为空槽。 */
const SEGMENT: Record<string, string> = {
	success: "bg-ok",
	running: "bg-signal",
	dispatched: "bg-signal",
	failed: "bg-danger",
	waiting: "bg-warn",
	skipped: "bg-skipped opacity-50",
	cancelled: "border border-dashed border-cancelled",
};

/** 已完成的节点（成功或跳过）。 */
const isDone = (status: string) => status === "success" || status === "skipped";

export const chainLabel = (chain: DashboardChain) =>
	chain.subflow ? `子流程 ${chain.chain_id}` : "主链";

/** 各链一行进度条，每个节点一段；读屏读出「主链 2/3」。 */
export function ChainBars({ chains }: { chains: DashboardChain[] }) {
	return (
		<span className="flex flex-col gap-0.75">
			{chains
				.filter((c) => c.nodes.length > 0)
				.map((chain) => {
					const done = chain.nodes.filter((n) => isDone(n.status)).length;
					const label = `${chainLabel(chain)} ${done}/${chain.nodes.length}`;
					return (
						<span
							key={chain.id}
							role="img"
							aria-label={label}
							title={label}
							className="flex gap-0.5"
						>
							{chain.nodes.map((node) => (
								<b
									key={node.node_id}
									className={cn("h-1.5 w-3.5 rounded-[2px]", SEGMENT[node.status] ?? "bg-track")}
								/>
							))}
						</span>
					);
				})}
		</span>
	);
}
