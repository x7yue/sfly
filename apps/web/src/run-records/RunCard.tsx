import type { RunListItem } from "@sfly/schema";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChainBar, doneCount } from "#/components/chain-progress";
import { nodeStatusView, runStatusView, StatusDot, StatusPill } from "#/components/status";
import { chainLabel } from "#/lib/copy";
import { formatDateTime, formatDuration, shortId } from "#/lib/format";
import { LIVE_POLL_MS } from "#/lib/polling";
import { NodePrimaryMetric } from "#/metrics/PrimaryMetric";
import { catalogEntry } from "#/metrics/use-primary-metric";
import { CancelRunButton } from "#/monitor/CancelRunDialog";
import { useMetricCatalog } from "#/monitor/use-run-metrics";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";

/** 卡片上最多列出的当前节点数。 */
const MAX_ACTIVE = 3;

/** 当前节点的状态点：排队为空心灰圈，等待唤醒为琥珀，其余（派发中、执行中）为青色。 */
const ACTIVE_DOT = {
	queued: { kind: "pending", color: "text-pending" },
	waiting: { kind: "warn", color: "text-warn" },
	running: { kind: "running", color: "text-signal" },
} as const;
const activeDot = (status: string) =>
	ACTIVE_DOT[status as keyof typeof ACTIVE_DOT] ?? ACTIVE_DOT.running;

/**
 * 进行中的运行（原型 runCard）：场景、版本、已运行时长、各链进度、失败的子流程、
 * 当前执行的节点与主指标（节点类型有主指标时，#43）或进度，「打开运行详情」「取消运行」。
 * 点卡片空白处也进入运行详情。
 */
export function RunCard({ run, now }: { run: RunListItem; now: number }) {
	const navigate = useNavigate();
	// 主指标：运行的指标目录在当前节点变化时重新获取，序列由各节点定时查询。
	const shown = run.active_nodes.slice(0, MAX_ACTIVE);
	const signature = shown.map((n) => `${n.chain_instance_id}/${n.node_id}:${n.status}`).join(",");
	const catalog = useMetricCatalog(run.id, signature, shown.length > 0);
	const failedSubflows = run.failures.filter((f) => f.subflow);
	const open = () => void navigate({ to: "/runs/$id", params: { id: run.id } });
	const status = runStatusView(run.status, { cancelling: run.cancelling });
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: 键盘用户用卡片里的「打开运行详情」链接
		<article
			aria-label={`运行 ${shortId(run.id)}`}
			onClick={(event) => {
				// 弹窗经 portal 渲染，事件仍会冒泡到这里：只处理卡片自身 DOM 内、不在链接与按钮上的点击。
				const target = event.target as HTMLElement;
				if (event.currentTarget.contains(target) && !target.closest("a, button")) open();
			}}
			className="flex cursor-pointer flex-col gap-1.5 rounded-xl border border-border-soft bg-surface px-3.5 py-3 transition-colors hover:border-border-strong"
		>
			<div className="flex items-center gap-2 whitespace-nowrap">
				<StatusPill kind={status.kind}>{status.label}</StatusPill>
				<b className="truncate font-medium">{run.orchestration_name}</b>
				<Badge className="font-mono">v{run.orchestration_version}</Badge>
				<span data-slot="run-id" className="font-mono text-xs text-fg-3">
					{shortId(run.id)}
				</span>
				<span className="flex-1" />
				<span className="font-mono text-sm" title="已运行">
					{formatDuration(now - Date.parse(run.started_at))}
				</span>
			</div>
			<div className="text-xs text-fg-3">
				{run.triggered_by} 触发 · 开始 {formatDateTime(run.started_at)}
				{failedSubflows.length > 0 && (
					<>
						{" · "}
						<span className="text-danger-fg">
							{failedSubflows.map((f) => chainLabel(f)).join("、")} 失败
						</span>
					</>
				)}
			</div>
			<div className="flex flex-col gap-1.5 py-1">
				{run.chains
					.filter((c) => c.nodes.length > 0)
					.map((chain) => (
						<div key={chain.id} className="flex items-center gap-2.5 text-sm">
							<span className="max-w-50 min-w-18 flex-none truncate text-fg-2">
								{chainLabel(chain)}
							</span>
							<ChainBar label={chainLabel(chain)} nodes={chain.nodes} />
							<span className="font-mono text-2xs text-fg-3">
								{doneCount(chain.nodes)}/{chain.nodes.length}
							</span>
						</div>
					))}
			</div>
			{run.active_nodes.length > 0 && (
				<ul className="m-0 flex list-none flex-col gap-1 border-t border-border-soft p-0 pt-2">
					{shown.map((node) => (
						<li
							key={`${node.chain_instance_id}/${node.node_id}`}
							className="flex items-center gap-2 text-sm whitespace-nowrap"
						>
							<StatusDot
								kind={activeDot(node.status).kind}
								className={activeDot(node.status).color}
							/>
							<span className="font-mono">{node.node_id}</span>
							<span className="text-xs text-fg-3">{nodeStatusView(node.status).label}</span>
							<NodePrimaryMetric
								runId={run.id}
								entry={catalogEntry(catalog.data, node.chain_instance_id, node.node_id)}
								status={node.status}
								poll={LIVE_POLL_MS}
								variant="inline"
								className="ml-auto max-w-[60%] flex-none text-xs"
								fallback={
									node.progress && (
										<span className="ml-auto font-mono text-xs text-fg-2">
											{node.progress.current}
											{node.progress.total !== null && ` / ${node.progress.total}`}
										</span>
									)
								}
							/>
						</li>
					))}
					{run.active_nodes.length > MAX_ACTIVE && (
						<li className="text-xs text-fg-3">
							另有 {run.active_nodes.length - MAX_ACTIVE} 个节点
						</li>
					)}
				</ul>
			)}
			<div className="flex gap-1.5 pt-1">
				<Link to="/runs/$id" params={{ id: run.id }} className={buttonVariants({ size: "sm" })}>
					打开运行详情
				</Link>
				{run.status === "running" && (
					<CancelRunButton
						size="sm"
						runId={run.id}
						orchestrationId={run.orchestration_id}
						orchestrationVersion={run.orchestration_version}
						cancelling={run.cancelling}
					/>
				)}
			</div>
		</article>
	);
}
