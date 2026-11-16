import type { DashboardEndedRun, DashboardRunFailure } from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { RotateCcwIcon } from "lucide-react";
import { useState } from "react";
import { listChainLabel } from "#/components/chain-progress";
import { NodeName } from "#/components/node-name";
import { runStatusView, StatusPill } from "#/components/status";
import { FocusReadoutStrip } from "#/focus/FocusReadout";
import { ACTION, DURATION_LABEL, PAGE, TERM } from "#/lib/copy";
import { formatDateTime, formatDuration, shortId } from "#/lib/format";
import { runViewQuery } from "#/monitor/live-run";
import { runMonitorLink } from "#/monitor/run-link";
import { RunDrawer } from "#/run-drawer/RunDrawer";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Truncate } from "@/components/ui/truncate";
import { DashboardPanel } from "./DashboardPanel";
import { PanelLink } from "./panel-link";

/**
 * 左栏下半：最近 24 小时结束的运行（最多 10 个），按结束时间从新到旧。失败的带错误类型、最先失败的节点、所在链、
 * 尝试号和最多两行错误信息、关注项的最终值（场景现在的关注项，最多 4 项），以及「打开失败节点」「再次运行」；成功和取消的只占一行。
 * `generatedAt` 是控制台统计的时刻（读数里「多久前」的参照）。
 */
export function EndedPanel({
	runs,
	generatedAt,
}: {
	runs: readonly DashboardEndedRun[];
	generatedAt: string;
}) {
	return (
		<DashboardPanel
			title="最近结束"
			count={runs.length}
			aside={<PanelLink to="/runs">{PAGE.runs}</PanelLink>}
		>
			{runs.length === 0 ? (
				<p className="m-0 px-3.5 py-6 text-center text-sm text-fg-3">最近 24 小时没有结束的运行</p>
			) : (
				<ul className="m-0 list-none p-0">
					{runs.map((run) => (
						<EndedRow key={run.id} run={run} generatedAt={generatedAt} />
					))}
				</ul>
			)}
		</DashboardPanel>
	);
}

function EndedRow({ run, generatedAt }: { run: DashboardEndedRun; generatedAt: string }) {
	const status = runStatusView(run.status);
	const failure = run.status === "failed" ? run.failure : null;
	const ended = (
		<span className="whitespace-nowrap">
			结束于 <span className="font-mono">{formatDateTime(run.ended_at)}</span> · {DURATION_LABEL}{" "}
			<span className="font-mono">
				{formatDuration(Date.parse(run.ended_at) - Date.parse(run.started_at))}
			</span>
		</span>
	);
	const title = (
		<div className="flex min-w-0 items-center gap-2">
			<StatusPill kind={status.kind}>{status.label}</StatusPill>
			<Truncate
				className="font-medium"
				render={
					<Link
						{...runMonitorLink(run.id, {})}
						className="text-fg-1 no-underline hover:underline"
					/>
				}
			>
				{run.orchestration_name}
			</Truncate>
			<span data-slot="run-id" className="flex-none font-mono text-xs text-fg-3">
				{shortId(run.id)}
			</span>
		</div>
	);
	if (run.status !== "failed") {
		return (
			<li
				data-run-status={run.status}
				className="flex items-center gap-3 border-b border-border-soft px-3.5 py-2 last:border-0"
			>
				<div className="flex min-w-0 flex-1 items-center gap-3">
					{title}
					<span className="text-xs text-fg-3">{ended}</span>
				</div>
				<RerunButton run={run} />
			</li>
		);
	}
	return (
		<li
			data-run-status={run.status}
			className="flex items-start gap-3 border-b border-border-soft px-3.5 py-2.5 last:border-0"
		>
			<div className="min-w-0 flex-1">
				{title}
				<div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-fg-3">
					{failure?.error && (
						<Badge variant="danger" className="font-mono">
							{failure.error.kind}
						</Badge>
					)}
					{failure && <FailureWhere failure={failure} />}
					{ended}
				</div>
				{failure?.error?.message && (
					<p className="m-0 mt-1.5 line-clamp-2 rounded-md bg-inset px-2.5 py-1.5 font-mono text-xs wrap-anywhere whitespace-pre-line text-fg-2">
						{failure.error.message}
					</p>
				)}
				{run.focus.length > 0 && (
					<FocusReadoutStrip
						items={run.focus}
						generatedAt={generatedAt}
						runEnded
						// 最多 3 项排一行；4 项排成两行两列，不留空格。
						columns={run.focus.length > 3 ? 2 : run.focus.length}
						className="mt-2 rounded-md border border-border-soft"
					/>
				)}
			</div>
			<div className="flex flex-none gap-1">
				{failure && (
					<Link
						{...runMonitorLink(run.id, { view: "detail", node: failure.node_id })}
						className={buttonVariants({ size: "sm" })}
					>
						打开失败节点
					</Link>
				)}
				<RerunButton run={run} />
			</div>
		</li>
	);
}

/** 「失败节点 submit · 主链 · 尝试 2」。 */
function FailureWhere({ failure }: { failure: DashboardRunFailure }) {
	return (
		<span className="min-w-0">
			失败节点{" "}
			<NodeName
				node={{ node_id: failure.node_id, display_name: failure.display_name }}
				className="text-fg-2"
			/>{" "}
			· {listChainLabel(failure)} · {TERM.attempt} {failure.attempt}
		</span>
	);
}

/** 「再次运行」：打开运行抽屉，参数和运行预设取自这次运行（读一次运行视图）。 */
function RerunButton({ run }: { run: DashboardEndedRun }) {
	const [open, setOpen] = useState(false);
	const navigate = useNavigate();
	const view = useQuery({ ...runViewQuery(run.id), enabled: open });
	return (
		<>
			<Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
				<RotateCcwIcon />
				{ACTION.rerun}
			</Button>
			{view.data && (
				<RunDrawer
					open={open}
					onOpenChange={setOpen}
					title={ACTION.rerun}
					orchestrationId={run.orchestration_id}
					name={run.orchestration_name}
					rerunOf={view.data}
					onTriggered={(next) => navigate(runMonitorLink(next.id, {}))}
				/>
			)}
		</>
	);
}
