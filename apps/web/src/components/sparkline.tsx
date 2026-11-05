import { cn } from "cn";
import { useMemo } from "react";

/**
 * 迷你趋势（原型 spark）：折线（可选面积），控制台统计卡与各处主指标共用。
 * 纵轴从 min(0, 最小值) 起、上方留 12%；横轴按 xs（缺省为序号）在 domain（缺省为 xs 的范围）里排开。
 * 宽度由 className 决定（SVG 横向拉伸，线宽不缩放）；少于两个点时不画。颜色缺省取 currentColor。
 */
export function Sparkline({
	values,
	xs,
	domain,
	color = "currentColor",
	area = false,
	height: H = 26,
	className,
}: {
	values: readonly number[];
	/** 每个值的横坐标（例如时间）；缺省为序号。 */
	xs?: readonly number[];
	/** 横轴范围；缺省为 xs 的最小到最大。 */
	domain?: readonly [number, number];
	color?: string;
	/** 折线下方画浅色面积。 */
	area?: boolean;
	/** 高度（px），也是 viewBox 的高度：边距按像素算。 */
	height?: number;
	className?: string;
}) {
	const path = useMemo(() => {
		if (values.length < 2) return null;
		const x = xs ?? values.map((_, i) => i);
		const [start, stop] = domain ?? [Math.min(...x), Math.max(...x)];
		const span = stop - start || 1;
		const min = Math.min(0, ...values);
		let max = Math.max(...values);
		if (max - min < 1e-9) max = min + 1;
		const top = max + (max - min) * 0.12;
		const X = (i: number) => (((x[i] ?? 0) - start) / span) * W;
		const Y = (v: number) => H - 2 - ((v - min) / (top - min)) * (H - 6);
		const line = `M${values.map((v, i) => `${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(" L")}`;
		return {
			line,
			area: `${line} L${X(values.length - 1).toFixed(1)} ${H} L${X(0).toFixed(1)} ${H}Z`,
		};
	}, [values, xs, domain, H]);
	if (!path) return null;
	return (
		<svg
			aria-hidden="true"
			data-sparkline
			viewBox={`0 0 ${W} ${H}`}
			preserveAspectRatio="none"
			className={cn("block", className)}
			style={{ height: H }}
		>
			{area && <path d={path.area} fill={color} opacity={0.13} />}
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

const W = 300;
