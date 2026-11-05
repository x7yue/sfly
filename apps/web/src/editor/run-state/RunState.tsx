import type { RunView } from "@sfly/schema";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { ActivityIcon, PanelRightCloseIcon } from "lucide-react";
import { forwardRef, type ReactNode, useMemo } from "react";
import type { DocNode } from "#/canvas/flow";
import { floatGroupClass } from "#/components/canvas/CanvasDock";
import type { CanvasContextValue, CanvasInfo, NodeDecoration } from "#/components/canvas/context";
import { KIND_META, nodeTitle } from "#/components/canvas/node-display";
import { ZOOM_TEXT_11 } from "#/components/canvas/zoom-text";
import { StatusPill } from "#/components/status";
import { formatDateTime, formatDuration } from "#/lib/format";
import { useNow } from "#/lib/use-now";
import { chainRunStatus, nodeStatus, runStatus, shortId } from "#/monitor/run-model";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { errorSummary, type NodeRunSummary, nodeElapsed, type RunOverlay } from "./run-overlay";
import type { CanvasRun } from "./use-canvas-run";

/**
 * 画布「运行状态」模式（原型 #/editor/:id?run=<id>，#41）的界面：画布叠加（decorateNode / decorateEdge /
 * regionMeta）、左上的运行状态、右上的监控页入口、右侧运行状态检查器。
 * 画布上只给状态与摘要；日志、图表、每次尝试的详情都只在运行监控页里。
 */

type Decorations = Pick<CanvasContextValue, "decorateNode" | "decorateEdge" | "regionMeta">;

/** 节点卡片、连线与子流程区域的运行状态叠加。 */
export function useRunDecorations(run: RunView | undefined, overlay: RunOverlay | undefined) {
	return useMemo((): Decorations => {
		if (!run || !overlay) return {};
		const ended = run.status !== "running";
		return {
			decorateNode: (id): NodeDecoration => {
				const summary = overlay.node(id);
				if (!summary) {
					// 子流程还没有触发（或运行结束时也没有触发）：节点没有运行记录。
					return {
						run: "pending",
						status: (
							<StatusPill kind="pending" className={ZOOM_TEXT_11}>
								{ended ? "未执行" : "待执行"}
							</StatusPill>
						),
					};
				}
				const s = nodeStatus(summary.node.status);
				// 主指标槽（slot）由 #43 在这里填上，现在沿用卡片底部的配置摘要。
				return {
					run: summary.state,
					status: (
						<StatusPill kind={s.kind} className={ZOOM_TEXT_11}>
							{s.label}
						</StatusPill>
					),
				};
			},
			decorateEdge: overlay.edge,
			regionMeta: (entryId) => {
				const instances = overlay.instances(entryId);
				if (instances.length === 0) return ended ? "未触发" : "还没有触发";
				const cancelling = run.cancel !== null;
				const statuses = instances.map((c) => chainRunStatus(c, cancelling));
				const shown =
					statuses.find((s) => s.kind === "running") ??
					statuses.find((s) => s.kind === "failed") ??
					statuses[0];
				return (
					<span className="inline-flex items-center gap-1.5">
						{instances.length > 1 && <span>{instances.length} 个实例 ·</span>}
						{shown && (
							<StatusPill kind={shown.kind} className={ZOOM_TEXT_11}>
								{shown.label}
							</StatusPill>
						)}
					</span>
				);
			},
		};
	}, [run, overlay]);
}

/** 左上控件组里替换检查状态的部分：运行状态、运行编号、耗时。 */
export function RunStateBadge({ state }: { state: CanvasRun }) {
	const running = state.status === "ready" && state.run.status === "running";
	const now = useNow(running);
	let body: ReactNode;
	switch (state.status) {
		case "loading":
			body = <span className="text-xs text-fg-3">加载运行…</span>;
			break;
		case "none":
			body = <StatusPill kind="pending">还没有运行</StatusPill>;
			break;
		case "error":
			body = <StatusPill kind="failed">无法加载运行</StatusPill>;
			break;
		case "ready": {
			const { run } = state;
			const s = runStatus(run);
			const end = run.ended_at ? Date.parse(run.ended_at) : now;
			body = (
				<>
					<StatusPill kind={s.kind}>{s.label}</StatusPill>
					<span className="font-mono text-xs">{shortId(run.id)}</span>
					<span className="font-mono text-xs text-fg-3">
						{formatDuration(end - Date.parse(run.started_at))}
					</span>
				</>
			);
		}
	}
	return (
		<span
			data-testid="canvas-run"
			title={state.status === "error" ? state.error.message : undefined}
			className="flex items-center gap-1.5 px-1.5"
		>
			{body}
		</span>
	);
}

/** 右上控件组（运行状态下替换保存 / 运行）：打开运行监控（主操作）。 */
export function RunTopRight({ run }: { run: RunView | undefined }) {
	if (!run) return null;
	return (
		<div className={cn(floatGroupClass, "top-3 right-3")}>
			<Link
				to="/runs/$id"
				params={{ id: run.id }}
				className={buttonVariants({ variant: "primary" })}
			>
				<ActivityIcon />
				打开运行监控
			</Link>
		</div>
	);
}

/**
 * 运行状态检查器：选中节点时是该节点在这次运行里的摘要（运行编号与版本、Agent、耗时、尝试次数、错误）
 * 和「在监控页中打开」（跳转后定位到该节点）；没有选中时是这次运行的概况。
 */
export const RunStateInspector = forwardRef<
	HTMLElement,
	{
		state: CanvasRun;
		selected: { id: string; node: DocNode } | null;
		info: CanvasInfo;
		onCollapse(): void;
		onEscape(): void;
	}
>(function RunStateInspector({ state, selected, info, onCollapse, onEscape }, ref) {
	return (
		<aside
			ref={ref}
			aria-label="检查器"
			tabIndex={-1}
			onKeyDown={(e) => {
				if (e.key === "Escape" && !e.defaultPrevented) {
					e.preventDefault();
					onEscape();
				}
			}}
			className="absolute top-15.5 right-3 bottom-3.5 z-10 flex w-93 flex-col overflow-hidden rounded-xl border border-border-soft bg-surface/94 shadow-float outline-none"
		>
			{state.status === "ready" && selected ? (
				<NodeRunInspector
					run={state.run}
					id={selected.id}
					node={selected.node}
					summary={state.overlay.node(selected.id)}
					info={info}
					onCollapse={onCollapse}
				/>
			) : (
				<RunOverview state={state} onCollapse={onCollapse} />
			)}
		</aside>
	);
});

function Header({ row, title, onCollapse }: { row: ReactNode; title: string; onCollapse(): void }) {
	return (
		<div className="flex-none border-b border-border-soft px-3.5 pt-3 pb-2.5">
			<div className="flex items-center gap-1.75 text-xs text-fg-3">
				{row}
				<span className="ml-auto flex items-center">
					<Button variant="ghost" size="icon-sm" aria-label="收起检查器" onClick={onCollapse}>
						<PanelRightCloseIcon />
					</Button>
				</span>
			</div>
			<h2 className="mt-1.5 mb-0.5 truncate text-base font-semibold">{title}</h2>
		</div>
	);
}

function Row({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
	return (
		<>
			<dt className="text-fg-3">{label}</dt>
			<dd className="m-0 min-w-0 truncate font-mono" data-testid={testId}>
				{children}
			</dd>
		</>
	);
}

const HINT = "日志、图表和每次尝试的详情都在运行监控页里。";

function NodeRunInspector({
	run,
	id,
	node,
	summary,
	info,
	onCollapse,
}: {
	run: RunView;
	id: string;
	node: DocNode;
	summary: NodeRunSummary | undefined;
	info: CanvasInfo;
	onCollapse(): void;
}) {
	const view = summary?.node;
	const now = useNow(run.status === "running");
	const elapsed = view ? nodeElapsed(view, now) : null;
	const status = view ? nodeStatus(view.status) : null;
	return (
		<>
			<Header
				row={
					<>
						<span className="font-mono text-fg-2">{id}</span>
						<span>· {KIND_META[node.kind].label}</span>
						<span className="ml-auto">
							{status && <StatusPill kind={status.kind}>{status.label}</StatusPill>}
						</span>
					</>
				}
				title={nodeTitle(node, info)}
				onCollapse={onCollapse}
			/>
			<div className="min-h-0 flex-1 overflow-auto px-3.5 py-3 text-sm">
				<dl
					data-testid="run-summary"
					className="m-0 grid grid-cols-[72px_1fr] gap-x-3 gap-y-1.5 text-xs"
				>
					<Row label="运行">
						{shortId(run.id)} · v{run.orchestration_version}
					</Row>
					<Row label="Agent">{view?.agent ?? "控制面"}</Row>
					<Row label="耗时">{elapsed === null ? "—" : formatDuration(elapsed)}</Row>
					<Row label="尝试" testId="run-attempts">
						{view?.attempts.length ?? 0}
					</Row>
					{summary && summary.instances > 1 && (
						<Row label="实例">第 1 个（共 {summary.instances} 个）</Row>
					)}
				</dl>
				{view?.error && (
					<div
						role="alert"
						className="mt-3 rounded-lg border border-danger-line bg-danger-soft px-3 py-2.5"
					>
						<Badge variant="danger" className="font-mono">
							{view.error.kind}
						</Badge>
						<p className="m-0 mt-1.5 break-words text-xs">{errorSummary(view.error)}</p>
					</div>
				)}
				{!view && (
					<p className="m-0 mt-3 text-xs text-fg-2">
						这个节点所在的子流程在这次运行里还没有触发，没有运行记录。
					</p>
				)}
				<p className="m-0 mt-3.5 mb-2.5 text-xs text-fg-3">{HINT}</p>
				{view && (
					<Link
						to="/runs/$id"
						params={{ id: run.id }}
						search={{ node: id }}
						className={buttonVariants()}
					>
						在监控页中打开 {id}
					</Link>
				)}
			</div>
		</>
	);
}

function RunOverview({ state, onCollapse }: { state: CanvasRun; onCollapse(): void }) {
	const running = state.status === "ready" && state.run.status === "running";
	const now = useNow(running);
	let body: ReactNode;
	switch (state.status) {
		case "loading":
			body = <p className="m-0 text-xs text-fg-3">加载运行…</p>;
			break;
		case "none":
			body = (
				<>
					<p className="m-0 text-sm">这个场景还没有运行过。</p>
					<p className="m-0 mt-1 text-xs text-fg-3">触发一次运行后，这里会显示各节点的状态。</p>
				</>
			);
			break;
		case "error":
			body = (
				<p role="alert" className="m-0 text-xs text-danger-fg">
					无法加载运行：{state.error.message}
				</p>
			);
			break;
		case "ready": {
			const { run } = state;
			const s = runStatus(run);
			const end = run.ended_at ? Date.parse(run.ended_at) : now;
			body = (
				<>
					<dl className="m-0 grid grid-cols-[72px_1fr] gap-x-3 gap-y-1.5 text-xs">
						<Row label="运行">
							{shortId(run.id)} · v{run.orchestration_version}
						</Row>
						<dt className="text-fg-3">状态</dt>
						<dd className="m-0">
							<StatusPill kind={s.kind}>{s.label}</StatusPill>
						</dd>
						<Row label="触发人">{run.triggered_by}</Row>
						<Row label="开始">{formatDateTime(run.started_at)}</Row>
						<Row label="耗时">{formatDuration(end - Date.parse(run.started_at))}</Row>
					</dl>
					<p className="m-0 mt-3.5 text-xs text-fg-3">选中节点查看它在这次运行里的摘要。{HINT}</p>
				</>
			);
		}
	}
	return (
		<>
			<Header row={<span>运行状态</span>} title="这次运行" onCollapse={onCollapse} />
			<div className="min-h-0 flex-1 overflow-auto px-3.5 py-3 text-sm">{body}</div>
		</>
	);
}
