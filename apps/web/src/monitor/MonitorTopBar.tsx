import { type RunView, runsApi } from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, ChevronDownIcon, PlayIcon, WorkflowIcon } from "lucide-react";
import { useState } from "react";
import { runStatusView, StatusDot, StatusPill } from "#/components/status";
import { apiQuery } from "#/lib/api";
import { formatDateTime, formatDuration, shortId } from "#/lib/format";
import { RunDrawer } from "#/run-drawer/RunDrawer";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CancelRunButton } from "./CancelRunDialog";
import { useTimeAxis } from "./monitor-state";
import { chainLabel, chainRunStatus, orderedChains, runStatus } from "./run-model";

/** 顶栏最多显示几条链的状态，其余收成「+N」。 */
const MAX_CHAIN_BADGES = 4;

/**
 * 运行监控页顶栏（原型 monitorHTML 的 `.mon-top`）：返回、场景名与版本、触发人 / 开始时间 / 已运行时长、
 * 运行切换（同场景的其他运行）、各链状态、在画布中查看、取消（运行中）或再次运行（已结束，主操作）。
 */
export function MonitorTopBar({ run, name }: { run: RunView; name: string | undefined }) {
	const { now, live } = useTimeAxis();
	const navigate = useNavigate();
	const [rerunOpen, setRerunOpen] = useState(false);
	const chains = orderedChains(run);
	const status = runStatus(run);
	const elapsed = (run.ended_at ? Date.parse(run.ended_at) : now) - Date.parse(run.started_at);

	return (
		<header className="flex h-13 flex-none items-center gap-2.5 border-b border-border-soft bg-surface px-3">
			<Link
				to="/runs"
				aria-label="返回运行记录"
				title="返回运行记录"
				className={buttonVariants({ variant: "ghost", size: "icon" })}
			>
				<ArrowLeftIcon />
			</Link>
			<div className="flex min-w-0 flex-col leading-tight">
				<h1 className="m-0 flex items-center gap-1.5 truncate text-sm font-semibold">
					<span className="truncate">{name ?? "场景"}</span>
					<Badge className="font-mono">v{run.orchestration_version}</Badge>
				</h1>
				<span className="truncate text-2xs text-fg-3">
					{run.triggered_by} 触发 · 开始 {formatDateTime(run.started_at)} ·{" "}
					<span className="font-mono" data-testid="run-elapsed">
						{live ? "已运行" : "耗时"} {formatDuration(elapsed)}
					</span>
				</span>
			</div>
			<span aria-hidden className="h-5 w-px bg-border" />
			<RunSwitcher run={run} />
			<span data-testid="run-status">
				<StatusPill kind={status.kind} className="text-sm">
					{status.label}
				</StatusPill>
			</span>
			<ul aria-label="各链状态" className="m-0 flex min-w-0 list-none gap-1.5 overflow-hidden p-0">
				{chains.slice(0, MAX_CHAIN_BADGES).map((chain) => {
					const s = chainRunStatus(chain, run.cancel !== null);
					return (
						<li key={chain.id}>
							<Badge title={`${chainLabel(chain)} · ${s.label}`}>
								{chain.depth === 0 ? (
									"主链"
								) : (
									<span className="font-mono">
										{chain.name || chain.chain_id} · {shortId(chain.id).slice(0, 4)}
									</span>
								)}
								<StatusDot kind={s.kind} />
								<span className="sr-only">{s.label}</span>
							</Badge>
						</li>
					);
				})}
				{chains.length > MAX_CHAIN_BADGES && (
					<li>
						<Badge>+{chains.length - MAX_CHAIN_BADGES} 条</Badge>
					</li>
				)}
			</ul>
			<span className="flex-1" />
			<Link
				to="/orchestrations/$id"
				params={{ id: run.orchestration_id }}
				search={{ run: run.id }}
				className={buttonVariants()}
			>
				<WorkflowIcon />
				在画布中查看
			</Link>
			{run.status === "running" ? (
				<CancelRunButton
					runId={run.id}
					orchestrationId={run.orchestration_id}
					orchestrationVersion={run.orchestration_version}
					cancelling={run.cancel !== null}
				/>
			) : (
				<Button variant="primary" onClick={() => setRerunOpen(true)}>
					<PlayIcon />
					再次运行
				</Button>
			)}
			<RunDrawer
				open={rerunOpen}
				onOpenChange={setRerunOpen}
				title="再次运行"
				orchestrationId={run.orchestration_id}
				name={name ?? "场景"}
				initialParams={run.params}
				onTriggered={(next) => navigate({ to: "/runs/$id", params: { id: next.id } })}
			/>
		</header>
	);
}

/** 运行切换：同一场景的其他运行（最近 200 条）。 */
function RunSwitcher({ run }: { run: RunView }) {
	const navigate = useNavigate();
	const [open, setOpen] = useState(false);
	const runs = useQuery({
		...apiQuery(runsApi.listForOrchestration, { params: { id: run.orchestration_id } }),
		enabled: open,
	});
	const status = runStatus(run);
	return (
		<DropdownMenu open={open} onOpenChange={setOpen}>
			<DropdownMenuTrigger
				render={
					<Button aria-label={`切换运行（当前 ${shortId(run.id)}）`} className="font-mono">
						<StatusDot kind={status.kind} />
						{shortId(run.id)}
						<ChevronDownIcon className="text-fg-3" />
					</Button>
				}
			/>
			<DropdownMenuContent className="w-auto min-w-105">
				<DropdownMenuGroup>
					<DropdownMenuLabel>本场景的运行</DropdownMenuLabel>
					{runs.isPending && <p className="m-0 px-1.5 py-1 text-xs text-fg-3">加载中…</p>}
					{runs.error && (
						<p className="m-0 px-1.5 py-1 text-xs text-danger-fg">无法加载：{runs.error.message}</p>
					)}
					{runs.data?.runs.map((r) => {
						const s = runStatusView(r.status, { cancelling: r.cancelling });
						return (
							<DropdownMenuItem
								key={r.id}
								aria-current={r.id === run.id || undefined}
								onClick={() => navigate({ to: "/runs/$id", params: { id: r.id } })}
								className="gap-2.5 aria-current:bg-raised-2"
							>
								<StatusPill kind={s.kind}>{s.label}</StatusPill>
								<span className="font-mono">{shortId(r.id)}</span>
								<span className="ml-auto pl-4 font-mono text-2xs text-fg-3">
									v{r.orchestration_version} · {r.triggered_by} · {formatDateTime(r.started_at)}
								</span>
							</DropdownMenuItem>
						);
					})}
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
