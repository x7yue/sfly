import { cn } from "cn";
import type { ComponentProps } from "react";

/**
 * React Flow UI 的 BaseNode（https://reactflow.dev/ui/components/base-node，拉取后按设计体系改写）：
 * 画布节点卡片的外壳。选中由 React Flow 给外层 `.react-flow__node` 加 `.selected`，这里用
 * `in-[.selected]:` 变体画中性高亮（selected 描边 + selected-ring），不用青色。
 * 尺寸由使用方给出（编排画布的几何常量在 components/canvas/geometry.ts）。
 */
export function BaseNode({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			data-slot="base-node"
			className={cn(
				"relative border border-canvas-node-border bg-canvas-node-bg text-fg-1 transition-[border-color,box-shadow,opacity] duration-150 ease-standard hover:border-border-strong",
				"in-[.selected]:border-canvas-node-selected in-[.selected]:hover:border-canvas-node-selected in-[.selected]:shadow-[0_0_0_4px_var(--canvas-node-selected-ring)]",
				className,
			)}
			{...props}
		/>
	);
}

/** 卡片标题行。 */
export function BaseNodeHeader({ className, ...props }: ComponentProps<"header">) {
	return (
		<header
			data-slot="base-node-header"
			className={cn("flex items-center gap-1.75 whitespace-nowrap", className)}
			{...props}
		/>
	);
}

/** 卡片标题（不可选中文字，像原生应用）。 */
export function BaseNodeHeaderTitle({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			data-slot="base-node-title"
			className={cn("truncate font-semibold select-none", className)}
			{...props}
		/>
	);
}

export function BaseNodeContent({ className, ...props }: ComponentProps<"div">) {
	return <div data-slot="base-node-content" className={cn("min-w-0", className)} {...props} />;
}
