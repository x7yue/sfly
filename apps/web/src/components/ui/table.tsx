import { cn } from "cn";
import type * as React from "react";

/**
 * 表格。表头吸在最近的滚动区顶端（列表页是外壳的主区域），往下翻也看得到列名。
 *
 * - `scroll`：默认 "none"，表格不包滚动容器（包了的话表头只会吸在这个容器里，等于不吸）；
 *   可能比容器宽的内容表格（文档里的表）传 "x"，横向滚动，表头不吸顶。
 * - 列宽（`TableHead` / `TableCell` 的 `width`，DataTable 写在列的 `meta.width`）：
 *   "fit" 按内容收紧、不折行（编号、状态、版本、时间、耗时、操作）；"grow" 吃掉剩下的宽度，
 *   内容放不下时单行截断（场景名、说明、错误信息，每张表只给一列）。都不写时按浏览器的自动布局。
 *   包名@版本、地址这类等宽标识符不在连字符处折行：放在 "fit" 列，或在 "grow" 列里用 `Truncate`。
 */
type TableScroll = "none" | "x";

function Table({
	className,
	scroll = "none",
	...props
}: React.ComponentProps<"table"> & { scroll?: TableScroll }) {
	const table = (
		<table
			data-slot="table"
			className={cn("w-full border-collapse text-sm", className)}
			{...props}
		/>
	);
	if (scroll === "none") return table;
	return (
		<div data-slot="table-container" className="relative w-full overflow-x-auto">
			{table}
		</div>
	);
}

/** 列宽的角色（见 Table 的说明）。 */
export type ColumnWidth = "fit" | "grow";

export const COLUMN_WIDTH: Record<ColumnWidth, string> = {
	fit: "w-px whitespace-nowrap",
	grow: "w-full max-w-0",
};

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
	return (
		<thead
			data-slot="table-header"
			className={cn("[&_tr]:border-0 [&_tr]:hover:bg-transparent", className)}
			{...props}
		/>
	);
}

/** 行进入视野时（J / K 移过去）让开吸顶表头的高度。 */
function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
	return (
		<tbody
			data-slot="table-body"
			className={cn("[&>tr]:scroll-mt-10 [&_tr:last-child]:border-0", className)}
			{...props}
		/>
	);
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
	return (
		<tfoot
			data-slot="table-footer"
			className={cn("border-t border-border-soft [&>tr]:last:border-b-0", className)}
			{...props}
		/>
	);
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
	return (
		<tr
			data-slot="table-row"
			className={cn(
				"border-b border-border-soft transition-colors hover:bg-fg-1/3 data-[state=selected]:selected-row",
				className,
			)}
			{...props}
		/>
	);
}

/**
 * 表头单元格：吸顶。分隔线画成单元格自己的内阴影——合并边框的表格里，边框属于表格网格，不跟着吸顶的单元格走。
 * 层级只靠 12px 与三级文字色区分，不加粗（雅黑没有 500，中文加不出中等字重）。
 */
function TableHead({
	className,
	width,
	...props
}: React.ComponentProps<"th"> & { width?: ColumnWidth | undefined }) {
	return (
		<th
			data-slot="table-head"
			className={cn(
				"sticky top-0 z-1 bg-surface px-3 py-2.25 text-left align-middle text-xs font-normal whitespace-nowrap text-fg-3 shadow-[inset_0_-1px_0_var(--border-soft)] forced-colors:border-b",
				width && COLUMN_WIDTH[width],
				className,
			)}
			{...props}
		/>
	);
}

function TableCell({
	className,
	width,
	...props
}: React.ComponentProps<"td"> & { width?: ColumnWidth | undefined }) {
	return (
		<td
			data-slot="table-cell"
			className={cn("px-3 py-2.5 align-middle", width && COLUMN_WIDTH[width], className)}
			{...props}
		/>
	);
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
	return (
		<caption
			data-slot="table-caption"
			className={cn("mt-3 text-xs text-fg-3", className)}
			{...props}
		/>
	);
}

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption };
