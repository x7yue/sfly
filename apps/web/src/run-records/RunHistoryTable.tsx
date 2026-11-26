import type { RunListItem } from "@sfly/schema";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { ChainBars, listChainLabel } from "#/components/chain-progress";
import { DataTable, dataColumns } from "#/components/data-table";
import { runNodeName } from "#/components/node-name";
import { runStatusView, StatusPill } from "#/components/status";
import { ViaTag } from "#/components/via-tag";
import { DURATION_LABEL } from "#/lib/copy";
import { formatDateTime, formatSpan, shortId } from "#/lib/format";
import { ScenarioWithPreset } from "#/presets/ScenarioWithPreset";

/** 表格里最多画几条链，其余只计数，保证行高一致。 */
const MAX_TABLE_CHAINS = 2;

/** 历史运行的列（原型 viewRuns 的表格）；now 是计算进行中耗时的当前时间。 */
const columns = dataColumns<RunListItem & { now: number }>((col) =>
	col.columns([
		col.display({
			id: "id",
			header: "运行",
			meta: { width: "fit", className: "font-mono" },
			cell: ({ row }) => (
				<Link
					to="/runs/$id"
					params={{ id: row.original.id }}
					data-slot="run-id"
					data-list-primary
					className="text-fg-1 hover:underline"
				>
					{shortId(row.original.id)}
				</Link>
			),
		}),
		col.display({
			id: "scenario",
			header: "场景",
			meta: { width: "grow" },
			cell: ({ row }) => (
				<ScenarioWithPreset name={row.original.orchestration_name} preset={row.original.preset} />
			),
		}),
		col.display({
			id: "status",
			header: "状态",
			meta: { width: "fit" },
			cell: ({ row }) => (
				<StatusPill kind={runStatusView(row.original.status).kind}>
					{statusText(row.original)}
				</StatusPill>
			),
		}),
		col.display({
			id: "progress",
			header: "进度",
			meta: { width: "fit" },
			cell: ({ row }) => <ChainBars chains={row.original.chains} max={MAX_TABLE_CHAINS} />,
		}),
		col.display({
			id: "version",
			header: "版本",
			meta: { width: "fit", className: "font-mono" },
			cell: ({ row }) => `v${row.original.orchestration_version}`,
		}),
		col.display({
			id: "triggered_by",
			header: "触发人",
			meta: { width: "fit" },
			cell: ({ row }) => (
				<>
					{row.original.triggered_by}
					<ViaTag
						via={row.original.triggered_via}
						session={row.original.session}
						className="text-fg-3"
					/>
				</>
			),
		}),
		col.display({
			id: "started_at",
			header: "开始",
			meta: { width: "fit", className: "font-mono text-xs text-fg-2" },
			cell: ({ row }) => formatDateTime(row.original.started_at),
		}),
		col.display({
			id: "duration",
			header: DURATION_LABEL,
			meta: { width: "fit", className: "text-right font-mono", headClassName: "text-right" },
			cell: ({ row }) => {
				const run = row.original;
				const end = run.ended_at ? Date.parse(run.ended_at) : run.now;
				return formatSpan(end - Date.parse(run.started_at), !run.ended_at);
			},
		}),
	]),
);

/**
 * 历史运行（原型 viewRuns 的表格，TanStack Table）：编号、场景、状态（与失败节点同一行）、各链进度、版本、
 * 触发人、开始时间、耗时。行高固定，点整行进入运行监控（编号是可聚焦的链接）。
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
				"data-list-item": "",
				className: "h-12 cursor-pointer whitespace-nowrap has-[:focus-visible]:bg-fg-1/3",
				onClick: (event) => {
					if ((event.target as HTMLElement).closest("a")) return;
					void navigate({ to: "/runs/$id", params: { id: row.original.id } });
				},
			})}
		/>
	);
}

/**
 * 状态文字；失败时带上第一个失败的节点（子流程里的节点带上子流程名）：`failures` 按失败的先后排，第一项就是它所在的链，
 * 和控制台、运行监控的页头是同一个节点。
 */
function statusText(run: RunListItem): string {
	const label = runStatusView(run.status).label;
	if (run.status !== "failed") return label;
	const [failure] = run.failures;
	if (!failure?.node_id) return label;
	const where = failure.subflow ? `${listChainLabel(failure)} / ` : "";
	const node = runNodeName({ node_id: failure.node_id, display_name: failure.display_name });
	return `${label} · ${where}${node}`;
}
