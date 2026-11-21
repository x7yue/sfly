import { cn } from "cn";
import { nodeStatusView, STATUS } from "#/components/status";
import { chainLabel, skippedCountLabel } from "#/lib/copy";
import { nodeStatusDisplay } from "#/lib/node-status";

/**
 * 各链进度条（原型 chainBars / chainBarsOne）：每个节点一段竖向短段，读屏读出「主链 2/3」。
 * 运行记录（卡片与表格）、运行抽屉共用；控制台和运行监控的概览画的是线路（components/run-lines）。
 */

/** 已完成的节点数（哪些状态算已完成见 lib/node-status；被跳过的不算，见 {@link chainSkippedText}）。 */
export const doneCount = (nodes: readonly { status: string }[]) =>
	nodes.filter((n) => nodeStatusDisplay(n.status)?.done).length;

/** 「2/3」：已完成的节点数 / 节点数，各链进度条与线路的计数和读屏名称都用它。 */
export const chainProgressText = (nodes: readonly { status: string }[]) =>
	`${doneCount(nodes)}/${nodes.length}`;

/** 「跳过 2」：被跳过的节点单独计数，没有被跳过的节点时为 null。 */
export function chainSkippedText(nodes: readonly { status: string }[]): string | null {
	const skipped = nodes.filter((n) => n.status === "skipped").length;
	return skipped === 0 ? null : skippedCountLabel(skipped);
}

/**
 * 一条链的计数：「1/3」，有被跳过的节点时后面接「· 跳过 2」（被跳过的不算已完成）。运行记录的卡片、运行抽屉的各链进度用它；
 * 线路（`run-lines`）里计数和「跳过 N」叠成两行，另写。
 */
export function ChainProgressCount({
	nodes,
	className,
}: {
	nodes: readonly { status: string }[];
	className?: string;
}) {
	const skipped = chainSkippedText(nodes);
	return (
		<span className={cn("text-2xs text-fg-3", className)}>
			<span className="font-mono">{chainProgressText(nodes)}</span>
			{skipped && <span data-skipped-count> · {skipped}</span>}
		</span>
	);
}

/** 一条链的进度条、线路缩略的读屏名称与提示：「主链 1/4」，有被跳过的节点时接上「，跳过 2」。 */
export function chainProgressName(label: string, nodes: readonly { status: string }[]): string {
	const skipped = chainSkippedText(nodes);
	return `${label} ${chainProgressText(nodes)}${skipped ? `，${skipped}` : ""}`;
}

const SHAPE = { tall: "h-3 w-1.5", short: "h-2 w-1.5" };

/** 一条链的进度条；label 是链的名称（{@link chainLabel}）。 */
export function ChainBar({
	label,
	nodes,
}: {
	label: string;
	nodes: readonly { node_id: string; status: string }[];
}) {
	const text = chainProgressName(label, nodes);
	return (
		<span
			role="img"
			aria-label={text}
			title={text}
			data-viz
			className="inline-flex flex-none items-center gap-0.5"
		>
			{nodes.map((node) => {
				const { area } = STATUS[nodeStatusView(node.status).kind];
				return (
					<b
						key={node.node_id}
						className={cn(
							"flex-none rounded-[2px]",
							area.tall ? SHAPE.tall : SHAPE.short,
							area.box,
						)}
					/>
				);
			})}
		</span>
	);
}

export interface ChainProgressData {
	id: string;
	chain_id: string;
	subflow: boolean;
	/** 子流程名称（运行列表、控制台统计从运行绑定的版本里补上）；主链没有。 */
	subflow_name?: string | undefined;
	nodes: readonly { node_id: string; status: string }[];
}

/** 运行列表、控制台里的链实例（或失败的链）的名称：「主链」或「子流程 <子流程名称>」。 */
export const listChainLabel = (chain: {
	chain_id: string;
	subflow: boolean;
	subflow_name?: string | undefined;
}) => chainLabel({ chain_id: chain.chain_id, subflow: chain.subflow, name: chain.subflow_name });

/** 各链一行进度条；给出 max 时最多画这么多条，其余只计数（保证表格行高一致）。 */
export function ChainBars({ chains, max }: { chains: readonly ChainProgressData[]; max?: number }) {
	const shown = chains.filter((c) => c.nodes.length > 0);
	const visible = max === undefined ? shown : shown.slice(0, max);
	const rest = shown.length - visible.length;
	return (
		<span className="flex items-center gap-2">
			<span className="flex flex-col gap-0.75">
				{visible.map((chain) => (
					<ChainBar key={chain.id} label={listChainLabel(chain)} nodes={chain.nodes} />
				))}
			</span>
			{rest > 0 && <span className="text-xs text-fg-3">+{rest} 条子流程</span>}
		</span>
	);
}
