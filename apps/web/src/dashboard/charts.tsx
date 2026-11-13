import type { DashboardHour } from "@sfly/schema";
import { cn } from "cn";
import { formatHourMinute } from "#/lib/format";

/** 控制台的小图：按小时的堆叠柱（原型 trend）；迷你趋势与各链进度条见 components/sparkline、chain-progress。 */

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
				<span className="text-xs">现在</span>
			</div>
		</div>
	);
}
