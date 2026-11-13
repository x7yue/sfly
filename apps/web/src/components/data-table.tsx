import {
	type ColumnDef,
	type ColumnHelper,
	createColumnHelper,
	type Row,
	type RowData,
	tableFeatures,
	useTable,
} from "@tanstack/react-table";
import type * as React from "react";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";

/**
 * 数据表格（规格 #25「表格用 TanStack Table」）：行与表头模型来自 TanStack Table，外观沿用 `ui/table`。
 * 列用 {@link dataColumns} 定义（表头、单元格、单元格 / 表头的类名），行的属性（点击、样式）由 rowProps 给出。
 *
 *   const columns = dataColumns<Run>((col) => [
 *     col.display({ id: "id", header: "运行", cell: ({ row }) => row.original.id, meta: { className: "font-mono" } }),
 *   ]);
 *   <DataTable aria-label="历史运行" columns={columns} data={runs} rowKey={(r) => r.id} />
 */

/** 列的展示设置。 */
export interface DataColumnMeta {
	/** 单元格的类名。 */
	className?: string;
	/** 表头的类名（默认同 className 里的对齐方式之外不加）。 */
	headClassName?: string;
}

const features = tableFeatures({ columnMeta: {} as DataColumnMeta });
type Features = typeof features;

// biome-ignore lint/suspicious/noExplicitAny: 各列的值类型不同
export type DataColumns<T extends RowData> = Array<ColumnDef<Features, T, any>>;

/** 定义列（放在模块顶层或 useMemo 里，保持稳定）。 */
export function dataColumns<T extends RowData>(
	define: (col: ColumnHelper<Features, T>) => DataColumns<T>,
): DataColumns<T> {
	return define(createColumnHelper<Features, T>());
}

export function DataTable<T extends RowData>({
	columns,
	data,
	rowKey,
	rowProps,
	...props
}: {
	columns: DataColumns<T>;
	data: readonly T[];
	rowKey: (row: T) => string;
	rowProps?: (
		row: Row<Features, T>,
	) => React.ComponentProps<typeof TableRow> & { [attribute: `data-${string}`]: string };
} & React.ComponentProps<typeof Table>) {
	const table = useTable({
		features,
		columns,
		data: data as T[],
		getRowId: (row) => rowKey(row),
	});
	return (
		<Table {...props}>
			<TableHeader>
				{table.getHeaderGroups().map((group) => (
					<TableRow key={group.id}>
						{group.headers.map((header) => (
							<TableHead key={header.id} className={header.column.columnDef.meta?.headClassName}>
								{header.isPlaceholder ? null : <table.FlexRender header={header} />}
							</TableHead>
						))}
					</TableRow>
				))}
			</TableHeader>
			<TableBody>
				{table.getRowModel().rows.map((row) => (
					<TableRow key={row.id} {...rowProps?.(row)}>
						{row.getAllCells().map((cell) => (
							<TableCell key={cell.id} className={cell.column.columnDef.meta?.className}>
								<table.FlexRender cell={cell} />
							</TableCell>
						))}
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}
