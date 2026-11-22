import { type RunView, runsApi } from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, ChevronDownIcon, PauseIcon, PlayIcon, WorkflowIcon } from "lucide-react";
import { useState } from "react";
import { NodeNameInline } from "#/components/node-name";
import { useShortcut } from "#/components/shortcuts";
import { runStatusView, StatusDot, StatusPill } from "#/components/status";
import { TriggeredAt } from "#/components/via-tag";
import { useRunFocus } from "#/focus/use-run-focus";
import { apiQuery } from "#/lib/api";
import { ACTION, DURATION_LABEL, ELAPSED_LABEL, FOCUS, MESSAGE } from "#/lib/copy";
import { formatClock, formatDateTime, formatSpan, shortId } from "#/lib/format";
import { toggleMotionPaused, useMotionPaused } from "#/lib/motion-pause";
import { shortcutText } from "#/lib/shortcuts";
import { runViewTransition } from "#/lib/view-transition";
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
import { Truncate } from "@/components/ui/truncate";
import { CancelRunButton } from "./CancelRunDialog";
import { useMonitorActions, useTimeAxis } from "./monitor-state";
import type { MonitorView } from "./monitor-view";
import { RunPresetInfo } from "./RunPresetInfo";
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
import { ViewTabs } from "./ViewTabs";

/** 顶栏最多显示几条链的状态，其余收成「+N」。 */
const MAX_CHAIN_BADGES = 4;

/**
 * 概览的「数据更新于 10:59:17」：关注项读数的生成时间（控制面时间，`generated_at`）。与概览读同一份读数
 * （同一个查询，不多发请求），盯运行的人看得出页面本身还在刷新；所以只在运行还在进行时显示（已结束的运行读数不再刷新，
 * 写「更新于」没有意义）。还没读到时不显示。
 */
function FocusFreshness({ run }: { run: RunView }) {
	const focus = useRunFocus(run.id, { live: run.status === "running" });
	const generatedAt = focus.data?.generated_at;
	if (!generatedAt) return null;
	return (
		<span data-testid="focus-freshness" className="flex-none text-xs whitespace-nowrap text-fg-3">
			{FOCUS.dataUpdated(formatClock(generatedAt))}
		</span>
	);
}

/**
 * 运行监控页顶栏（原型 monitorHTML 的 `.mon-top`）：返回、场景名与版本、触发人 / 开始时间 / 已运行时长、
 * 运行切换（同场景的其他运行）、运行状态（运行还在进行时，概览里后面写「数据更新于」）、「概览 / 详情」标签页、失败摘要（有节点最终失败、运行结束与否都有：第一个失败的节点，点击查看它的尝试；
 * 页面里已经有失败区域（概览）或失败横幅（详情）时不重复，只在它们看不到的地方出现，同一屏上同一件事只说一次）、各链状态、
 * 在画布中打开、取消（运行中）或再次运行（已结束，主操作）。
 * 窗口窄于 1280 时左侧信息截断、各链状态隐藏、右侧按钮只显示图标，操作始终可点。失败摘要只用别的内容占完之后剩下的宽度
 * （最窄 96px，全文在悬停提示里）：预设名、场景名和耗时在宽的窗口里原样显示，窄的窗口里
 * 才按各链状态（整个收起，不留半截）、预设名、场景名与触发信息的顺序让位；耗时、状态、视图标签页和按钮不让位。
 * 运行状态标签是页面级唯一的整体脉冲（执行中时）。
 */
export function MonitorTopBar({
	run,
	name,
	failureShown,
	view,
	onViewChange,
}: {
	run: RunView;
	name: string | undefined;
	/** 页面里已经有一处写着失败（概览的失败区域、详情的失败横幅）：顶栏不再重复一遍摘要。 */
	failureShown: boolean;
	view: MonitorView;
	onViewChange: (view: MonitorView) => void;
}) {
	const { now, live } = useTimeAxis();
	const paused = useMotionPaused();
	const navigate = useNavigate();
	const [rerunOpen, setRerunOpen] = useState(false);
	useShortcut("monitor-rerun", () => setRerunOpen(true), run.status !== "running");
	const chains = orderedChains(run);
	const status = runStatus(run);
	// 运行还没结束、已经有节点最终失败时也有（不等运行结束）。页面里已经写着失败的地方（概览的失败区域、详情的失败横幅）
	// 顶栏不再写一遍：同一屏上同一件事只说一次；看不到它们的地方（详情里收起了横幅、运行还在进行时的详情）顶栏照常显示。
	const failure = runFailure(run);
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
			{/* 窄的时候先截断场景名和触发人、开始时间；耗时是盯运行的人要看的，不让出位置。 */}
			<div className="flex min-w-44 shrink-[2] flex-col leading-tight">
				<h1 className="m-0 flex items-center gap-1.5 truncate text-sm font-semibold">
					<span className="truncate">{name ?? "场景"}</span>
					<Badge className="font-mono">v{run.orchestration_version}</Badge>
				</h1>
				<span className="flex min-w-0 text-xs text-fg-3">
					<span className="min-w-0 truncate">
						<TriggeredAt by={run.triggered_by} via={run.triggered_via} at={run.started_at} />
					</span>
					<span className="flex-none whitespace-pre">
						{" · "}
						<span className="font-mono" data-testid="run-elapsed">
							{live ? ELAPSED_LABEL : DURATION_LABEL} {formatSpan(elapsed, live)}
						</span>
					</span>
				</span>
			</div>
			<span aria-hidden className="h-5 w-px flex-none bg-border" />
			<RunSwitcher run={run} />
			{/* output 即 role="status"（礼貌播报）：运行状态变化时读屏会读出来。 */}
			<output data-testid="run-status" aria-live="polite" className="flex-none">
				<StatusPill kind={status.kind} pulse className="vt-run-state text-sm">
					{status.label}
				</StatusPill>
			</output>
			{view === "overview" && run.status === "running" && <FocusFreshness run={run} />}
			{run.preset && <RunPresetInfo preset={run.preset} />}
			<ViewTabs view={view} onChange={onViewChange} />
			{failure && !failureShown && <FailureSummary failure={failure} />}
			<ul
				aria-label="各链状态"
				className="m-0 flex min-w-0 shrink-1000 list-none gap-1.5 overflow-hidden p-0 max-xl:hidden"
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
			{(live || paused) && (
				<Button
					variant="ghost"
					size="icon"
					aria-label="暂停动效"
					aria-pressed={paused}
					title={paused ? "动效已暂停（全站），点击恢复" : "暂停全站的脉冲动效"}
					className="aria-pressed:bg-raised-2 aria-pressed:text-fg-1"
					onClick={toggleMotionPaused}
				>
					<PauseIcon />
				</Button>
			)}
			<Link
				to="/orchestrations/$id"
				params={{ id: run.orchestration_id }}
				search={{ run: run.id }}
				viewTransition={runViewTransition("to-canvas")}
				title={ACTION.openInCanvas}
				className={buttonVariants({ className: COLLAPSE_BUTTON })}
			>
				<WorkflowIcon />
				<span className={COLLAPSE_LABEL}>{ACTION.openInCanvas}</span>
			</Link>
			{run.status === "running" ? (
				<CancelRunButton
					runId={run.id}
					orchestrationId={run.orchestration_id}
					orchestrationVersion={run.orchestration_version}
					cancelling={run.cancel !== null}
					collapse
					shortcut="monitor-cancel"
				/>
			) : (
				<Button
					variant="primary"
					title={`${ACTION.rerun}（${shortcutText("monitor-rerun")}）`}
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
				rerunOf={run}
				onTriggered={(next) => navigate({ to: "/runs/$id", params: { id: next.id } })}
			/>
		</header>
	);
}

/**
 * 失败摘要：「失败于 verify（第 2 次尝试）· AssertionError: …」，太长时截断（悬停看完整的第一行）。
 * 只在详情里没有失败横幅时出现（概览有失败区域）。点击选中这个节点，并把底部面板切到「尝试」页签（错误类型与堆栈）。
 */
function FailureSummary({ failure }: { failure: RunFailure }) {
	const actions = useMonitorActions();
	return (
		<Truncate
			label={`${failureSummary(failure)}\n点击查看这个节点的尝试`}
			render={
				<button
					type="button"
					aria-description="点击查看这个节点的尝试"
					data-testid="run-failure"
					onClick={() => actions.report({ type: "failure", node: failure.ref })}
					className="block h-6.5 min-w-24 max-w-max flex-[100_1_0%] truncate rounded-md px-1.5 text-left text-xs leading-6.5 text-fg-2 hover:bg-raised hover:text-fg-1"
				/>
			}
		>
			失败于{" "}
			<span className="text-fg-1">
				<NodeNameInline node={failure.node} />
			</span>
			{failureAttempt(failure)}
			{failure.message && (
				<span className="text-danger-fg">
					{failureMessageSeparator(failure)}
					{failure.message}
				</span>
			)}
		</Truncate>
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
					{runs.isPending && <p className="m-0 px-1.5 py-1 text-xs text-fg-3">{MESSAGE.loading}</p>}
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
