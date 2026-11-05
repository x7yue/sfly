import { cn } from "cn";
import { useRef, useState } from "react";

/**
 * 区块边缘的高度拖动条（原型 `.tl-drag` / `.bp-drag`）：按住拖动调整高度，双击恢复默认。
 * edge：拖动条在区块的下沿（往下拖变高）还是上沿（往上拖变高）。
 * 也可以用键盘：聚焦后按上下方向键每次调整 16px，Enter 恢复默认。
 */
export function ResizeHandle({
	label,
	edge,
	height,
	measure,
	min,
	max,
	onResize,
	onReset,
}: {
	label: string;
	edge: "top" | "bottom";
	/** 当前设置的高度；null 表示默认高度。 */
	height: number | null;
	/** 开始拖动时区块的实际高度。 */
	measure: () => number;
	min: number;
	max: () => number;
	onResize: (height: number) => void;
	onReset: () => void;
}) {
	const drag = useRef<{ y: number; h: number } | null>(null);
	const [active, setActive] = useState(false);
	const clamp = (h: number) => Math.round(Math.max(min, Math.min(max(), h)));
	const sign = edge === "bottom" ? 1 : -1;
	return (
		// biome-ignore lint/a11y/useSemanticElements: 可拖动的分隔条没有对应的原生元素（hr 不能聚焦）
		<div
			role="separator"
			aria-orientation="horizontal"
			aria-label={label}
			aria-valuenow={height ?? undefined}
			tabIndex={0}
			title={`${label}（双击恢复默认）`}
			data-active={active || undefined}
			className={cn(
				"group absolute right-0 left-0 z-10 h-2.25 cursor-row-resize outline-offset-[-2px]",
				edge === "bottom" ? "-bottom-1.25" : "-top-1.25",
			)}
			onPointerDown={(e) => {
				if (e.button !== 0) return;
				e.preventDefault();
				e.currentTarget.setPointerCapture(e.pointerId);
				drag.current = { y: e.clientY, h: measure() };
				setActive(true);
			}}
			onPointerMove={(e) => {
				const start = drag.current;
				if (start) onResize(clamp(start.h + sign * (e.clientY - start.y)));
			}}
			onPointerUp={() => {
				drag.current = null;
				setActive(false);
			}}
			onPointerCancel={() => {
				drag.current = null;
				setActive(false);
			}}
			onDoubleClick={onReset}
			onKeyDown={(e) => {
				if (e.key === "ArrowUp" || e.key === "ArrowDown") {
					e.preventDefault();
					const delta = (e.key === "ArrowDown" ? 16 : -16) * sign;
					onResize(clamp((height ?? measure()) + delta));
				} else if (e.key === "Enter") {
					e.preventDefault();
					onReset();
				}
			}}
		>
			<span
				aria-hidden
				className="absolute top-0.75 left-1/2 h-0.75 w-10 -translate-x-1/2 rounded-[2px] bg-border-strong opacity-55 transition-opacity group-hover:opacity-100 group-data-active:opacity-100"
			/>
		</div>
	);
}
