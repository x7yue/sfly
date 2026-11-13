import { cn } from "cn";
import { useId, useLayoutEffect, useRef, useState } from "react";

type Edge = "top" | "bottom" | "left";

const EDGE_CLASS: Record<Edge, string> = {
	top: "right-0 left-0 -top-1.25 h-2.25 cursor-row-resize",
	bottom: "right-0 left-0 -bottom-1.25 h-2.25 cursor-row-resize",
	// 面板自己裁剪溢出（圆角），拖动条贴在边缘内侧。
	left: "top-0 bottom-0 left-0 w-2.25 cursor-col-resize",
};

/**
 * 区块边缘的拖动条（原型 `.tl-drag` / `.bp-drag`）：按住拖动调整大小，双击恢复默认。
 * edge：拖动条在区块的哪条边——下沿（往下拖变高）、上沿（往上拖变高）调高度，左沿（往左拖变宽）调宽度。
 * 也可以用键盘：聚焦后按方向键（调高度用上下，调宽度用左右）每次调整 16px，Enter 恢复默认。
 */
export function ResizeHandle({
	label,
	edge,
	size,
	measure,
	min,
	max,
	onResize,
	onReset,
}: {
	label: string;
	edge: Edge;
	/** 当前设置的大小（高度或宽度）；null 表示默认。 */
	size: number | null;
	/** 开始拖动时区块的实际大小。 */
	measure: () => number;
	min: number;
	max: () => number;
	onResize: (size: number) => void;
	onReset: () => void;
}) {
	const drag = useRef<{ at: number; size: number } | null>(null);
	const [active, setActive] = useState(false);
	const hintId = useId();
	const [reading, setReading] = useState({ now: min, max: min });
	const refresh = () =>
		setReading((prev) => {
			const next = { now: Math.round(measure()), max: Math.round(max()) };
			return prev.now === next.now && prev.max === next.max ? prev : next;
		});
	// 大小取决于布局，React 不跟踪：每次渲染后量一次，窗口缩放后聚焦时再量一次。
	useLayoutEffect(refresh);
	const clamp = (s: number) => Math.round(Math.max(min, Math.min(max(), s)));
	const horizontal = edge === "left";
	const sign = edge === "bottom" ? 1 : -1;
	const [shrinkKey, growKey] = horizontal ? ["ArrowRight", "ArrowLeft"] : ["ArrowUp", "ArrowDown"];
	const pointer = (e: React.PointerEvent) => (horizontal ? e.clientX : e.clientY);
	return (
		// biome-ignore lint/a11y/useSemanticElements: 可拖动的分隔条没有对应的原生元素（hr 不能聚焦）
		<div
			role="separator"
			aria-orientation={horizontal ? "vertical" : "horizontal"}
			aria-label={label}
			aria-valuemin={min}
			aria-valuemax={Math.max(min, reading.max)}
			aria-valuenow={Math.min(Math.max(min, reading.now), Math.max(min, reading.max))}
			aria-describedby={hintId}
			tabIndex={0}
			title={`${label}（双击恢复默认）`}
			data-active={active || undefined}
			className={cn("group absolute z-10 outline-offset-[-2px]", EDGE_CLASS[edge])}
			onPointerDown={(e) => {
				if (e.button !== 0) return;
				e.preventDefault();
				e.currentTarget.setPointerCapture(e.pointerId);
				drag.current = { at: pointer(e), size: measure() };
				setActive(true);
			}}
			onPointerMove={(e) => {
				const start = drag.current;
				if (start) onResize(clamp(start.size + sign * (pointer(e) - start.at)));
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
			onFocus={refresh}
			onKeyDown={(e) => {
				if (e.key === shrinkKey || e.key === growKey) {
					e.preventDefault();
					// 调高度时「下」总是把拖动条往下移：在下沿变高，在上沿变矮。
					const grow = horizontal ? e.key === growKey : (e.key === growKey) === (sign === 1);
					onResize(clamp((size ?? measure()) + (grow ? 16 : -16)));
				} else if (e.key === "Enter") {
					e.preventDefault();
					onReset();
				}
			}}
		>
			<span id={hintId} className="sr-only">
				{`${horizontal ? "左右" : "上下"}方向键每次调整 16 像素，双击或按 Enter 恢复默认`}
			</span>
			<span
				aria-hidden
				className={cn(
					"absolute rounded-[2px] bg-border-strong opacity-55 transition-opacity group-hover:opacity-100 group-data-active:opacity-100",
					horizontal
						? "top-1/2 left-0.75 h-10 w-0.75 -translate-y-1/2"
						: "top-0.75 left-1/2 h-0.75 w-10 -translate-x-1/2",
				)}
			/>
		</div>
	);
}
