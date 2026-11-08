import { type RunView, runsApi } from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, ChevronDownIcon, PlayIcon, WorkflowIcon } from "lucide-react";
import { useState } from "react";
import { runStatusView, StatusDot, StatusPill } from "#/components/status";
import { apiQuery } from "#/lib/api";
import { ACTION } from "#/lib/copy";
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
import { useMonitorActions, useTimeAxis } from "./monitor-state";
import {
	chainLabel,
	chainRunStatus,
	failureAttempt,
	failureMessageSeparator,
	failureSummary,
	orderedChains,
	type RunFailure,
	runFailure,
	runStatus,
} from "./run-model";
import { COLLAPSE_BUTTON, COLLAPSE_LABEL, MONITOR_TOPBAR_HEIGHT } from "./top-bar";

/** 顶栏最多显示几条链的状态，其余收成「+N」。 */
const MAX_CHAIN_BADGES = 4;

/**
 * 运行监控页顶栏（原型 monitorHTML 的 `.mon-top`）：返回、场景名与版本、触发人 / 开始时间 / 已运行时长、
 * 运行切换（同场景的其他运行）、运行状态、失败摘要（失败的运行：第一个失败的节点，点击查看它的尝试）、各链状态、
 * 在画布中查看、取消（运行中）或再次运行（已结束，主操作）。
 * 窗口窄于 1280 时左侧信息截断、各链状态隐藏、右侧按钮只显示图标，操作始终可点。
 */
export function MonitorTopBar({ run, name }: { run: RunView; name: string | undefined }) {
	const { now, live } = useTimeAxis();
	const navigate = useNavigate();
	const [rerunOpen, setRerunOpen] = useState(false);
	const chains = orderedChains(run);
	const status = runStatus(run);
	const failure = run.status === "failed" ? runFailure(run) : null;
	const elapsed = (run.ended_at ? Date.parse(run.ended_at) : now) - Date.parse(run.started_at);

	return (
		<header
			style={{ height: MONITOR_TOPBAR_HEIGHT }}
			className="flex flex-none items-center gap-2.5 border-b border-border-soft bg-surface px-3"
		>
			<Link
				to="/runs"
				aria-label="返回运行记录"
				title="返回运行记录"
				className={buttonVariants({ variant: "ghost", size: "icon" })}
			>
				<ArrowLeftIcon />
			</Link>
			<div className="flex min-w-36 shrink flex-col leading-tight">
				<h1 className="m-0 flex items-center gap-1.5 truncate text-sm font-semibold">
					<span className="truncate">{name ?? "场景"}</span>
					<Badge className="font-mono">v{run.orchestration_version}</Badge>
				</h1>
				<span className="truncate text-xs text-fg-3">
					{run.triggered_by} 触发 · 开始 {formatDateTime(run.started_at)} ·{" "}
					<span className="font-mono" data-testid="run-elapsed">
						{live ? "已运行" : "耗时"} {formatDuration(elapsed)}
					</span>
				</span>
			</div>
			<span aria-hidden className="h-5 w-px flex-none bg-border" />
			<RunSwitcher run={run} />
			{/* output 即 role="status"（礼貌播报）：运行状态变化时读屏会读出来。 */}
			<output data-testid="run-status" aria-live="polite" className="flex-none">
				<StatusPill kind={status.kind} className="text-sm">
					{status.label}
				</StatusPill>
			</output>
			{failure && <FailureSummary failure={failure} />}
			<ul
				aria-label="各链状态"
				className="m-0 flex min-w-0 shrink-[4] list-none gap-1.5 overflow-hidden p-0 max-xl:hidden"
			>
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
			<span className="min-w-0 flex-1" />
			<Link
				to="/orchestrations/$id"
				params={{ id: run.orchestration_id }}
				search={{ run: run.id }}
				title="在画布中查看"
				className={buttonVariants({ className: COLLAPSE_BUTTON })}
			>
				<WorkflowIcon />
				<span className={COLLAPSE_LABEL}>在画布中查看</span>
			</Link>
			{run.status === "running" ? (
				<CancelRunButton
					runId={run.id}
					orchestrationId={run.orchestration_id}
					orchestrationVersion={run.orchestration_version}
					cancelling={run.cancel !== null}
					collapse
				/>
			) : (
				<Button
					variant="primary"
					title={ACTION.rerun}
					className={COLLAPSE_BUTTON}
					onClick={() => setRerunOpen(true)}
				>
					<PlayIcon />
					<span className={COLLAPSE_LABEL}>{ACTION.rerun}</span>
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

/**
 * 失败摘要：「失败于 verify（第 2 次）· AssertionError: …」，太长时截断（悬停看完整的第一行）。
 * 点击选中这个节点，并把底部面板切到「尝试」页签（错误类型与堆栈）。
 */
function FailureSummary({ failure }: { failure: RunFailure }) {
	const actions = useMonitorActions();
	return (
		<button
			type="button"
			title={`${failureSummary(failure)}\n点击查看这个节点的尝试`}
			data-testid="run-failure"
			onClick={() => {
				actions.select(failure.ref);
				actions.showPanel("attempts");
			}}
			className="block h-6.5 min-w-24 shrink-[2] truncate rounded-md px-1.5 text-left text-xs leading-6.5 text-fg-2 hover:bg-raised hover:text-fg-1"
		>
			失败于 <span className="font-mono text-fg-1">{failure.nodeId}</span>
			{failureAttempt(failure)}
			{failure.message && (
				<span className="text-danger-fg">
					{failureMessageSeparator(failure)}
					{failure.message}
				</span>
			)}
		</button>
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
								<span className="ml-auto pl-4 font-mono text-xs text-fg-3">
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
