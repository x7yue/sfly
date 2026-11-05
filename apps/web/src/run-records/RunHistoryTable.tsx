import type { RunListItem } from "@sfly/schema";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { ChainBars } from "#/components/chain-progress";
import { DataTable, dataColumns } from "#/components/data-table";
import { runStatusView, StatusPill } from "#/components/status";
import { chainLabel } from "#/lib/copy";
import { formatDateTime, formatDuration, shortId } from "#/lib/format";

/** 表格里最多画几条链，其余只计数，保证行高一致。 */
const MAX_TABLE_CHAINS = 2;

/** 历史运行的列（原型 viewRuns 的表格）；now 是计算进行中耗时的当前时间。 */
const columns = dataColumns<RunListItem & { now: number }>((col) =>
	col.columns([
		col.display({
			id: "id",
			header: "运行",
			meta: { className: "font-mono" },
			cell: ({ row }) => (
				<Link
					to="/runs/$id"
					params={{ id: row.original.id }}
					data-slot="run-id"
					className="text-fg-1 hover:underline"
				>
					{shortId(row.original.id)}
				</Link>
			),
		}),
		col.display({
			id: "scenario",
			header: "场景",
			meta: { className: "max-w-60 truncate" },
			cell: ({ row }) => row.original.orchestration_name,
		}),
		col.display({
			id: "status",
			header: "状态",
			cell: ({ row }) => (
				<StatusPill kind={runStatusView(row.original.status).kind}>
					{statusText(row.original)}
				</StatusPill>
			),
		}),
		col.display({
			id: "progress",
			header: "进度",
			cell: ({ row }) => <ChainBars chains={row.original.chains} max={MAX_TABLE_CHAINS} />,
		}),
		col.display({
			id: "version",
			header: "版本",
			meta: { className: "font-mono" },
			cell: ({ row }) => `v${row.original.orchestration_version}`,
		}),
		col.display({
			id: "triggered_by",
			header: "触发人",
			meta: { className: "max-w-40 truncate" },
			cell: ({ row }) => row.original.triggered_by,
		}),
		col.display({
			id: "started_at",
			header: "开始",
			meta: { className: "font-mono text-xs text-fg-2" },
			cell: ({ row }) => formatDateTime(row.original.started_at),
		}),
		col.display({
			id: "duration",
			header: "耗时",
			meta: { className: "text-right font-mono", headClassName: "text-right" },
			cell: ({ row }) => {
				const run = row.original;
				const end = run.ended_at ? Date.parse(run.ended_at) : run.now;
				return formatDuration(end - Date.parse(run.started_at));
			},
		}),
	]),
);

/**
 * 历史运行（原型 viewRuns 的表格，TanStack Table）：编号、场景、状态（与失败节点同一行）、各链进度、版本、
 * 触发人、开始时间、耗时。行高固定，点整行进入运行详情（编号是可聚焦的链接）。
 */
export function RunHistoryTable({ runs, now }: { runs: RunListItem[]; now: number }) {
	const navigate = useNavigate();
	const data = useMemo(() => runs.map((run) => ({ ...run, now })), [runs, now]);
	return (
		<DataTable
			aria-label="历史运行"
			columns={columns}
			data={data}
			rowKey={(run) => run.id}
			rowProps={(row) => ({
				className: "h-12 cursor-pointer whitespace-nowrap",
				onClick: (event) => {
					if ((event.target as HTMLElement).closest("a")) return;
					void navigate({ to: "/runs/$id", params: { id: row.original.id } });
				},
			})}
		/>
	);
}

/** 状态文字；失败时带上失败节点（子流程里的节点带上子流程名）。 */
function statusText(run: RunListItem): string {
	const label = runStatusView(run.status).label;
	if (run.status !== "failed") return label;
	const failure = run.failures.find((f) => !f.subflow) ?? run.failures[0];
	if (!failure?.node_id) return label;
	const where = failure.subflow ? `${chainLabel(failure)} / ` : "";
	return `${label} · ${where}${failure.node_id}`;
}
