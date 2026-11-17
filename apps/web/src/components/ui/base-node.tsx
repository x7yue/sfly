import { cn } from "cn";
import type { ComponentProps } from "react";

/**
 * React Flow UI 的 BaseNode（https://reactflow.dev/ui/components/base-node，拉取后按设计体系改写）：
 * 画布节点卡片的外壳。选中由 React Flow 给外层 `.react-flow__node` 加 `.selected`，这里用
 * `in-[.selected]:` 变体在卡片外面先垫 3px 画布底色、再画 2px 中性的 `selected` 描边（原型第四版），不用青色。
 * 卡片自己的描边不变：执行中的青色、失败的红色选中后照样看得见；键盘焦点环再往外一圈（NodeCard 的 `outline-offset`）。
 * 强制颜色模式下 box-shadow 没有了，改画隔开一圈的 `Highlight` 轮廓（styles/app.css）。
 * 尺寸由使用方给出（编排画布的几何常量在 components/canvas/geometry.ts）。
 */
export function BaseNode({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			data-slot="base-node"
			className={cn(
				"relative border border-canvas-node-border bg-canvas-node-bg text-fg-1 transition-[border-color,box-shadow,opacity] duration-150 ease-standard hover:border-border-strong",
				"in-[.selected]:shadow-[0_0_0_3px_var(--canvas-bg),0_0_0_5px_var(--canvas-node-selected)]",
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
