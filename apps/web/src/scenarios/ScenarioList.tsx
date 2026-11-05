import type { LastRun, OrchestrationSummary } from "@sfly/schema";
import { Link, useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import {
	ArchiveIcon,
	ArchiveRestoreIcon,
	CopyIcon,
	EllipsisIcon,
	HistoryIcon,
	PencilLineIcon,
	PlayIcon,
	SquarePenIcon,
	WorkflowIcon,
} from "lucide-react";
import { createContext, type ReactNode, useContext, useRef, useState } from "react";
import { StatusDot, type StatusKind, StatusPill } from "#/components/status";
import { formatDateTime } from "#/lib/format";
import { RunDrawer } from "#/run-drawer/RunDrawer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import {
	ArchiveScenarioDialog,
	CopyScenarioDialog,
	EditScenarioDialog,
	useUnarchiveScenario,
} from "./dialogs";
import { ScenarioThumbnail } from "./ScenarioThumbnail";

/** 场景列表的卡片视图与表格视图（原型 #/scenarios：scenarioCard、表格视图、scMenu）。 */

const RUN_STATUS: Record<LastRun["status"], { kind: StatusKind; label: string }> = {
	running: { kind: "running", label: "运行中" },
	success: { kind: "ok", label: "成功" },
	failed: { kind: "failed", label: "失败" },
	cancelled: { kind: "cancelled", label: "已取消" },
};

const pad = (n: number) => String(n).padStart(2, "0");

/** 耗时：`42s`、`12m 03s`、`1h 05m`。 */
export function formatDuration(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
	return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
}

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
			{offline > 0 && <span className="text-2xs text-warn">{offline} 个不在线，任务会排队</span>}
		</div>
	);
}

/** 最近一次运行：状态、开始时间、触发人、耗时；运行中时状态可以直接进入监控页。 */
function LastRunInfo({ run, className }: { run: LastRun | null; className?: string }) {
	if (!run) return <span className="text-fg-3">从未运行</span>;
	const status = RUN_STATUS[run.status];
	const end = run.ended_at ? new Date(run.ended_at).getTime() : Date.now();
	const pill = <StatusPill kind={status.kind}>{status.label}</StatusPill>;
	return (
		<span className={cn("inline-flex flex-wrap items-center gap-2", className)}>
			{run.status === "running" ? (
				<Link to="/runs/$id" params={{ id: run.id }} aria-label="进入运行监控">
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
 * 卡片和表格行共用的操作：「编排」「运行」常驻，「更多」菜单含版本历史、复制、编辑名称和说明、归档；
 * 已归档的场景只能恢复。「运行」打开运行抽屉（ScenarioRunDrawer）。
 */
function ScenarioActions({
	scenario,
	compact = false,
}: {
	scenario: OrchestrationSummary;
	/** 表格里不显示「编排」按钮（名称就是链接）。 */
	compact?: boolean;
}) {
	const navigate = useNavigate();
	const more = useRef<HTMLButtonElement>(null);
	const [dialog, setDialog] = useState<"copy" | "edit" | "archive" | null>(null);
	const openRunDrawer = useContext(RunDrawerContext);
	const unarchive = useUnarchiveScenario();
	const close = (open: boolean) => {
		if (!open) setDialog(null);
	};
	const running = scenario.last_run?.status === "running";

	if (scenario.archived_at) {
		return (
			<Button size="sm" disabled={unarchive.isPending} onClick={() => unarchive.mutate(scenario)}>
				<ArchiveRestoreIcon />
				恢复
			</Button>
		);
	}
	return (
		<>
			{!compact && (
				<Button
					size="sm"
					render={<Link to="/orchestrations/$id" params={{ id: scenario.id }} />}
					nativeButton={false}
				>
					<SquarePenIcon />
					编排
				</Button>
			)}
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
				<DropdownMenuContent align="end" className="w-48">
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
	return (
		<article
			aria-label={scenario.name}
			className="flex flex-col overflow-hidden rounded-xl border border-border-soft bg-surface transition-colors hover:border-border-strong"
		>
			<div className="relative h-37 border-b border-border-soft bg-sunk bg-[radial-gradient(var(--canvas-grid)_1px,transparent_1px)] bg-size-[14px_14px]">
				<Link
					to="/orchestrations/$id"
					params={{ id: scenario.id }}
					title="打开编排画布"
					aria-label={`打开「${scenario.name}」的编排画布`}
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
				{run?.status === "running" && (
					<Link
						to="/runs/$id"
						params={{ id: run.id }}
						className="absolute top-2.25 right-2.5 inline-flex h-5 items-center rounded-md border border-signal-line bg-raised-2 px-1.75"
						aria-label="运行中，进入运行监控"
					>
						<StatusPill kind="running" className="text-2xs">
							运行中
						</StatusPill>
					</Link>
				)}
			</div>
			<div className="flex flex-1 flex-col gap-2 px-3.5 pt-3 pb-2.5">
				<h3 className="m-0 truncate text-base font-semibold">
					<Link to="/orchestrations/$id" params={{ id: scenario.id }} className="hover:underline">
						{scenario.name}
					</Link>
				</h3>
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

/** 表格视图。 */
export function ScenarioTable({ scenarios }: { scenarios: OrchestrationSummary[] }) {
	return (
		<Table aria-label="场景列表">
			<TableHeader>
				<TableRow>
					<TableHead>场景</TableHead>
					<TableHead>最近运行</TableHead>
					<TableHead>Agent</TableHead>
					<TableHead>版本</TableHead>
					<TableHead>节点</TableHead>
					<TableHead>更新</TableHead>
					<TableHead>
						<span className="sr-only">操作</span>
					</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{scenarios.map((s) => (
					<TableRow key={s.id}>
						<TableCell className="max-w-90">
							<Link
								to="/orchestrations/$id"
								params={{ id: s.id }}
								className="inline-flex items-center gap-1.5 font-medium hover:underline"
							>
								<WorkflowIcon className="size-3.5 text-fg-3" />
								{s.name}
							</Link>
							<div className="truncate text-xs text-fg-3">{s.description || "没有说明"}</div>
						</TableCell>
						<TableCell className="text-xs whitespace-nowrap text-fg-2">
							<LastRunInfo run={s.last_run} className="flex-nowrap" />
						</TableCell>
						<TableCell>
							<AgentChips scenario={s} />
						</TableCell>
						<TableCell className="font-mono whitespace-nowrap">{versionLabel(s)}</TableCell>
						<TableCell className="text-xs whitespace-nowrap text-fg-2">
							{s.node_count}
							{s.subflow_count > 0 && ` · ${s.subflow_count} 子流程`}
						</TableCell>
						<TableCell className="font-mono text-xs whitespace-nowrap text-fg-3">
							{formatDateTime(s.archived_at ?? s.updated_at)}
						</TableCell>
						<TableCell>
							<div className="flex items-center justify-end gap-1.5">
								<ScenarioActions scenario={s} compact />
							</div>
						</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}
