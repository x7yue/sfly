import type { LastRun, OrchestrationSummary } from "@sfly/schema";
import { Link, useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import {
	ArchiveIcon,
	ArchiveRestoreIcon,
	BellIcon,
	CopyIcon,
	EllipsisIcon,
	HistoryIcon,
	PencilLineIcon,
	PlayIcon,
	WorkflowIcon,
} from "lucide-react";
import { createContext, type ReactNode, useContext, useRef, useState } from "react";
import { DataTable, dataColumns } from "#/components/data-table";
import { runStatusView, StatusDot, StatusPill } from "#/components/status";
import { controlPlaneNow } from "#/lib/control-plane-time";
import { ACTION, TERM } from "#/lib/copy";
import { formatDateTime, formatDuration } from "#/lib/format";
import { RunDrawer } from "#/run-drawer/RunDrawer";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	ArchiveScenarioDialog,
	CopyScenarioDialog,
	EditScenarioDialog,
	useUnarchiveScenario,
} from "./dialogs";
import { RunNotificationDialog } from "./RunNotificationDialog";
import { ScenarioThumbnail } from "./ScenarioThumbnail";

/** 场景列表的卡片视图与表格视图（原型 #/scenarios：scenarioCard、表格视图、scMenu）。 */

const versionLabel = (s: OrchestrationSummary) =>
	s.head_version === 0 ? "未保存" : `v${s.head_version}`;

/** 引用的 Agent 与在线状态：默认 Agent 在前；有不在线的提示任务会排队。 */
function AgentChips({ scenario }: { scenario: OrchestrationSummary }) {
	if (scenario.agents.length === 0) {
		return <span className="text-xs text-fg-3">未选择 Agent</span>;
	}
	const offline = scenario.agents.filter((a) => a.status !== "online").length;
	return (
		<div className="flex flex-wrap items-center gap-1.5">
			{scenario.agents.map((a) => {
				const state = a.status === "online" ? "在线" : a.status === "offline" ? "离线" : "未注册";
				return (
					<span
						key={a.name}
						title={`${a.name}${a.default ? "（默认 Agent）" : ""} · ${state}`}
						className={cn(
							"inline-flex h-5.5 items-center gap-1.25 rounded-md border border-border-soft bg-raised px-1.75 font-mono text-2xs",
							a.default ? "text-fg-1" : "text-fg-2",
							a.status !== "online" && "border-dashed text-fg-3",
						)}
					>
						<StatusDot
							kind={a.status === "online" ? "ok" : "pending"}
							className={a.status === "online" ? "text-ok" : "text-pending"}
						/>
						{a.name}
						<span className="sr-only">
							（{a.default ? "默认 Agent，" : ""}
							{state}）
						</span>
					</span>
				);
			})}
			{offline > 0 && <span className="text-xs text-warn">{offline} 个不在线，任务会排队</span>}
		</div>
	);
}

/** 最近一次运行：状态、开始时间、触发人、耗时；运行中时状态可以直接进入监控页。 */
function LastRunInfo({ run, className }: { run: LastRun | null; className?: string }) {
	if (!run) return <span className="text-fg-3">从未运行</span>;
	// 取消后等待清理的运行显示为「取消中」（故事 70）。
	const status = runStatusView(run.status, { cancelling: run.cancelling });
	const end = run.ended_at ? new Date(run.ended_at).getTime() : controlPlaneNow();
	const pill = <StatusPill kind={status.kind}>{status.label}</StatusPill>;
	return (
		<span className={cn("inline-flex flex-wrap items-center gap-2", className)}>
			{run.status === "running" ? (
				<Link to="/runs/$id" params={{ id: run.id }} aria-label={`${status.label}，进入运行监控`}>
					{pill}
				</Link>
			) : (
				pill
			)}
			<span className="font-mono">{formatDateTime(run.started_at)}</span>
			<span>{run.triggered_by}</span>
			<span className="font-mono">{formatDuration(end - new Date(run.started_at).getTime())}</span>
		</span>
	);
}

type OpenRunDrawer = (scenario: OrchestrationSummary, from: HTMLElement | null) => void;
const RunDrawerContext = createContext<OpenRunDrawer>(() => {});

/**
 * 场景列表页的运行抽屉：放在页面一级，列表刷新、筛选让卡片消失时抽屉照常显示；离开页面时随页面关闭。
 * 预检问题的「前往」进入编排画布并选中该节点。
 */
export function ScenarioRunDrawer({ children }: { children: ReactNode }) {
	const navigate = useNavigate();
	const [target, setTarget] = useState<OrchestrationSummary | null>(null);
	const [open, setOpen] = useState(false);
	const returnFocus = useRef<HTMLElement | null>(null);
	const openDrawer: OpenRunDrawer = (scenario, from) => {
		returnFocus.current = from;
		setTarget(scenario);
		setOpen(true);
	};
	return (
		<RunDrawerContext.Provider value={openDrawer}>
			{children}
			{target && (
				<RunDrawer
					open={open}
					onOpenChange={setOpen}
					finalFocus={returnFocus}
					orchestrationId={target.id}
					name={target.name}
					description={target.description}
					onLocate={(node) =>
						navigate({ to: "/orchestrations/$id", params: { id: target.id }, search: { node } })
					}
				/>
			)}
		</RunDrawerContext.Provider>
	);
}

/**
 * 卡片和表格行共用的操作：「运行」常驻，「更多」菜单含版本历史、复制、编辑名称和说明、运行通知、归档；
 * 已归档的场景只能恢复，或者查看它的运行记录。「运行」打开运行抽屉（ScenarioRunDrawer）。
 * 进入编排画布用场景名称的链接，这里不放去同一处的按钮。
 */
function ScenarioActions({ scenario }: { scenario: OrchestrationSummary }) {
	const navigate = useNavigate();
	const more = useRef<HTMLButtonElement>(null);
	const [dialog, setDialog] = useState<"copy" | "edit" | "notify" | "archive" | null>(null);
	const openRunDrawer = useContext(RunDrawerContext);
	const unarchive = useUnarchiveScenario();
	const close = (open: boolean) => {
		if (!open) setDialog(null);
	};
	const running = scenario.last_run?.status === "running";

	if (scenario.archived_at) {
		// 已归档的场景不能再运行，历史运行仍可回看（故事 26）。
		return (
			<>
				<Button size="sm" disabled={unarchive.isPending} onClick={() => unarchive.mutate(scenario)}>
					<ArchiveRestoreIcon />
					恢复
				</Button>
				<Link
					to="/runs"
					search={{ scenario: scenario.id }}
					className={buttonVariants({ size: "sm", variant: "ghost" })}
				>
					<HistoryIcon />
					{ACTION.viewRuns}
				</Link>
			</>
		);
	}
	return (
		<>
			<Button size="sm" onClick={(e) => openRunDrawer(scenario, e.currentTarget)}>
				<PlayIcon />
				运行
			</Button>
			<DropdownMenu>
				<DropdownMenuTrigger
					ref={more}
					render={<Button variant="ghost" size="icon-sm" aria-label="更多操作" />}
				>
					<EllipsisIcon />
				</DropdownMenuTrigger>
				<DropdownMenuContent className="w-48">
					<DropdownMenuItem
						onClick={() =>
							navigate({ to: "/orchestrations/$id/versions", params: { id: scenario.id } })
						}
					>
						<HistoryIcon />
						版本历史
					</DropdownMenuItem>
					<DropdownMenuItem onClick={() => setDialog("copy")}>
						<CopyIcon />
						复制场景…
					</DropdownMenuItem>
					<DropdownMenuItem onClick={() => setDialog("edit")}>
						<PencilLineIcon />
						编辑名称和说明…
					</DropdownMenuItem>
					<DropdownMenuItem onClick={() => setDialog("notify")}>
						<BellIcon />
						{TERM.runNotification}…
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						variant="destructive"
						disabled={running}
						onClick={() => setDialog("archive")}
					>
						<ArchiveIcon />
						归档…
						{running && <span className="ml-auto text-2xs text-fg-3">运行中不可归档</span>}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<CopyScenarioDialog
				scenario={scenario}
				open={dialog === "copy"}
				onOpenChange={close}
				returnFocus={more}
			/>
			<EditScenarioDialog
				scenario={scenario}
				open={dialog === "edit"}
				onOpenChange={close}
				returnFocus={more}
			/>
			<RunNotificationDialog
				scenario={scenario}
				open={dialog === "notify"}
				onOpenChange={close}
				returnFocus={more}
			/>
			<ArchiveScenarioDialog
				scenario={scenario}
				open={dialog === "archive"}
				onOpenChange={close}
				returnFocus={more}
			/>
		</>
	);
}

function ScenarioCard({ scenario }: { scenario: OrchestrationSummary }) {
	const run = scenario.last_run;
	const live =
		run?.status === "running" ? runStatusView(run.status, { cancelling: run.cancelling }) : null;
	return (
		<article
			aria-label={scenario.name}
			className="flex flex-col overflow-hidden rounded-xl border border-border-soft bg-surface transition-colors hover:border-border-strong"
		>
			<div className="relative h-37 border-b border-border-soft bg-sunk bg-[radial-gradient(var(--canvas-grid)_1px,transparent_1px)] bg-size-[14px_14px]">
				{/* 缩略图只是鼠标的大点击区，与名称链接去同一处：不进 Tab 顺序，读屏不重复读。 */}
				<Link
					to="/orchestrations/$id"
					params={{ id: scenario.id }}
					title="打开编排画布"
					tabIndex={-1}
					aria-hidden
					className="absolute inset-x-3 top-9 bottom-2.5"
				>
					<ScenarioThumbnail structure={scenario.structure} nodeStates={run?.node_states ?? null} />
				</Link>
				<div className="absolute top-2.25 left-2.5 flex gap-1.5">
					<Badge className="font-mono">{versionLabel(scenario)}</Badge>
					<Badge>
						{scenario.node_count} 节点
						{scenario.subflow_count > 0 && ` · ${scenario.subflow_count} 子流程`}
					</Badge>
				</div>
				{/* 与「最近运行」里的状态链接重复：键盘和读屏用那一个。 */}
				{run && live && (
					<Link
						to="/runs/$id"
						params={{ id: run.id }}
						tabIndex={-1}
						aria-hidden
						className={cn(
							"absolute top-2.25 right-2.5 inline-flex h-5 items-center rounded-md border bg-raised-2 px-1.75",
							live.kind === "running" ? "border-signal-line" : "border-border",
						)}
					>
						<StatusPill kind={live.kind} className="text-2xs">
							{live.label}
						</StatusPill>
					</Link>
				)}
			</div>
			<div className="flex flex-1 flex-col gap-2 px-3.5 pt-3 pb-2.5">
				<h2 className="m-0 truncate text-base font-semibold">
					<Link to="/orchestrations/$id" params={{ id: scenario.id }} className="hover:underline">
						{scenario.name}
					</Link>
				</h2>
				<p
					className={cn(
						"m-0 line-clamp-2 min-h-10 text-sm",
						scenario.description ? "text-fg-2" : "text-fg-3",
					)}
				>
					{scenario.description || "没有说明"}
				</p>
				<AgentChips scenario={scenario} />
				<div className="mt-auto flex flex-wrap items-center gap-2 text-xs text-fg-3">
					最近运行 <LastRunInfo run={run} />
				</div>
			</div>
			<footer className="flex items-center gap-1.5 border-t border-border-soft px-3.5 py-2.5">
				<ScenarioActions scenario={scenario} />
				<span className="flex-1" />
				<span className="text-2xs text-fg-3">
					{scenario.archived_at
						? `归档于 ${formatDateTime(scenario.archived_at)}`
						: `更新于 ${formatDateTime(scenario.updated_at)}`}
				</span>
			</footer>
		</article>
	);
}

/** 卡片视图：自适应列数，每张最小 316px。 */
export function ScenarioCards({ scenarios }: { scenarios: OrchestrationSummary[] }) {
	return (
		<div className="grid grid-cols-[repeat(auto-fill,minmax(316px,1fr))] gap-3.5">
			{scenarios.map((s) => (
				<ScenarioCard key={s.id} scenario={s} />
			))}
		</div>
	);
}

/** 表格视图的列（TanStack Table）。 */
const tableColumns = dataColumns<OrchestrationSummary>((col) =>
	col.columns([
		col.display({
			id: "name",
			header: "场景",
			meta: { className: "max-w-90" },
			cell: ({ row: { original: s } }) => (
				<>
					<Link
						to="/orchestrations/$id"
						params={{ id: s.id }}
						className="inline-flex items-center gap-1.5 font-medium hover:underline"
					>
						<WorkflowIcon className="size-3.5 text-fg-3" />
						{s.name}
					</Link>
					<div className="truncate text-xs text-fg-3">{s.description || "没有说明"}</div>
				</>
			),
		}),
		col.display({
			id: "last_run",
			header: "最近运行",
			meta: { className: "text-xs whitespace-nowrap text-fg-2" },
			cell: ({ row }) => <LastRunInfo run={row.original.last_run} className="flex-nowrap" />,
		}),
		col.display({
			id: "agents",
			header: "Agent",
			cell: ({ row }) => <AgentChips scenario={row.original} />,
		}),
		col.display({
			id: "version",
			header: "版本",
			meta: { className: "font-mono whitespace-nowrap" },
			cell: ({ row }) => versionLabel(row.original),
		}),
		col.display({
			id: "nodes",
			header: "节点",
			meta: { className: "text-xs whitespace-nowrap text-fg-2" },
			cell: ({ row: { original: s } }) =>
				`${s.node_count}${s.subflow_count > 0 ? ` · ${s.subflow_count} 子流程` : ""}`,
		}),
		col.display({
			id: "updated",
			header: "更新",
			meta: { className: "font-mono text-xs whitespace-nowrap text-fg-3" },
			cell: ({ row: { original: s } }) => formatDateTime(s.archived_at ?? s.updated_at),
		}),
		col.display({
			id: "actions",
			header: () => <span className="sr-only">操作</span>,
			cell: ({ row }) => (
				<div className="flex items-center justify-end gap-1.5">
					<ScenarioActions scenario={row.original} />
				</div>
			),
		}),
	]),
);

/** 表格视图。 */
export function ScenarioTable({ scenarios }: { scenarios: OrchestrationSummary[] }) {
	return (
		<DataTable aria-label="场景列表" columns={tableColumns} data={scenarios} rowKey={(s) => s.id} />
	);
}
