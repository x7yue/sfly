import type { RunListItem } from "@sfly/schema";
import { Link, useNavigate } from "@tanstack/react-router";
import { StatusPill } from "#/components/status";
import { formatDateTime } from "#/lib/format";
import { durationBetween, shortId } from "#/runs/format";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { ChainBars, chainLabel, RUN_STATUS } from "./ChainProgress";

/**
 * 历史运行（原型 viewRuns 的表格）：编号、场景、状态（与失败节点同一行）、各链进度、版本、
 * 触发人、开始时间、耗时。行高固定，点整行进入运行详情（编号是可聚焦的链接）。
 */
export function RunHistoryTable({ runs, now }: { runs: RunListItem[]; now: number }) {
	const navigate = useNavigate();
	return (
		<Table aria-label="历史运行">
			<TableHeader>
				<TableRow>
					<TableHead>运行</TableHead>
					<TableHead>场景</TableHead>
					<TableHead>状态</TableHead>
					<TableHead>进度</TableHead>
					<TableHead>版本</TableHead>
					<TableHead>触发人</TableHead>
					<TableHead>开始</TableHead>
					<TableHead className="text-right">耗时</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{runs.map((run) => (
					<TableRow
						key={run.id}
						className="h-12 cursor-pointer whitespace-nowrap"
						onClick={(event) => {
							if ((event.target as HTMLElement).closest("a")) return;
							void navigate({ to: "/runs/$id", params: { id: run.id } });
						}}
					>
						<TableCell className="font-mono">
							<Link
								to="/runs/$id"
								params={{ id: run.id }}
								data-slot="run-id"
								className="text-fg-1 hover:underline"
							>
								{shortId(run.id)}
							</Link>
						</TableCell>
						<TableCell className="max-w-60 truncate">{run.orchestration_name}</TableCell>
						<TableCell>
							<StatusPill kind={RUN_STATUS[run.status].kind}>{statusText(run)}</StatusPill>
						</TableCell>
						<TableCell>
							<ChainBars chains={run.chains} />
						</TableCell>
						<TableCell className="font-mono">v{run.orchestration_version}</TableCell>
						<TableCell className="max-w-40 truncate">{run.triggered_by}</TableCell>
						<TableCell className="font-mono text-xs text-fg-2">
							{formatDateTime(run.started_at)}
						</TableCell>
						<TableCell className="text-right font-mono">
							{durationBetween(run.started_at, run.ended_at, now)}
						</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}

/** 状态文字；失败时带上失败节点（子流程里的节点带上子流程名）。 */
function statusText(run: RunListItem): string {
	const label = RUN_STATUS[run.status].label;
	if (run.status !== "failed") return label;
	const failure = run.failures.find((f) => !f.subflow) ?? run.failures[0];
	if (!failure?.node_id) return label;
	const where = failure.subflow ? `${chainLabel(failure)} / ` : "";
	return `${label} · ${where}${failure.node_id}`;
}
