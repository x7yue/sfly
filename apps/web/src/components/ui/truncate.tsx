import { cn } from "cn";
import { useLayoutEffect, useRef, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * 单行截断（docs/DESIGN-SYSTEM.md「长文本与截断」）：放不下时末尾省略；真的被截断时，悬停或键盘聚焦都会弹出全文。
 * 全文始终在 DOM 里（读屏、页内查找、复制拿到的都是全文），提示只是给看得见的人补上被截掉的部分。
 *
 *   <Truncate>{scenario.name}</Truncate>                                   // 普通文字：截断时可以 Tab 到它
 *   <Truncate render={<Link to=… data-list-primary />}>{name}</Truncate>   // 链接、按钮本身截断：聚焦它就弹出
 *   <Truncate keepEnd={6}>{"sfly-stub/metric_rate@0.1.0"}</Truncate>       // 结尾 6 个字符始终可见（版本号）
 *
 * 外层要给它一个有限的宽度（flex / grid 里的项写 `min-w-0`）。标题不用它：标题最多两行（`line-clamp-2`），不截成一行。
 */
export function Truncate({
	children,
	keepEnd = 0,
	render,
	className,
}: {
	children: string;
	/** 结尾始终显示的字符数：版本号、扩展名这类最有区分度的部分。 */
	keepEnd?: number;
	/** 截断的是交互元素本身（链接、按钮）时传入它，提示跟着它的悬停与聚焦出现。 */
	render?: React.ReactElement<Record<string, unknown>>;
	className?: string;
}) {
	const clipped = useRef<HTMLSpanElement>(null);
	const [truncated, setTruncated] = useState(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: ResizeObserver 只在尺寸变化时回调，文字变了要重新量
	useLayoutEffect(() => {
		const element = clipped.current;
		if (!element) return;
		const check = () => setTruncated(element.scrollWidth > element.clientWidth);
		check();
		const observer = new ResizeObserver(check);
		observer.observe(element);
		return () => observer.disconnect();
	}, [children, keepEnd]);

	const split = keepEnd > 0 && keepEnd < children.length;
	const text = split ? (
		<span className="flex min-w-0 whitespace-nowrap">
			<span ref={clipped} className="truncate">
				{children.slice(0, -keepEnd)}
			</span>
			{children.slice(-keepEnd)}
		</span>
	) : (
		<span ref={clipped} className="block truncate">
			{children}
		</span>
	);
	return (
		<Tooltip disabled={!truncated}>
			<TooltipTrigger
				data-slot="truncate"
				data-truncated={truncated || undefined}
				render={render ?? <span tabIndex={truncated ? 0 : undefined} className="block min-w-0" />}
				className={cn("min-w-0", className)}
			>
				{text}
			</TooltipTrigger>
			<TooltipContent className="max-w-md wrap-anywhere">{children}</TooltipContent>
		</Tooltip>
	);
}
