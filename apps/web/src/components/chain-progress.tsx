import { cn } from "cn";
import { nodeStatusView, STATUS } from "#/components/status";
import { chainLabel } from "#/lib/copy";
import { nodeStatusDisplay } from "#/lib/node-status";

/**
 * 各链进度条（原型 chainBars / chainBarsOne）：每个节点一段，读屏读出「主链 2/3」。
 * 控制台、运行记录（卡片与表格）、运行抽屉共用。
 *
 * variant：`ticks` 竖向短段（运行记录、运行抽屉）；`wide` 横向长段（控制台「正在运行」）。
 */
export type ChainProgressVariant = "ticks" | "wide";

/** 已完成的节点数（哪些状态算已完成见 lib/node-status）。 */
export const doneCount = (nodes: readonly { status: string }[]) =>
	nodes.filter((n) => nodeStatusDisplay(n.status)?.done).length;

const SHAPE: Record<ChainProgressVariant, { tall: string; short: string }> = {
	ticks: { tall: "h-3 w-1.5", short: "h-2 w-1.5" },
	wide: { tall: "h-2 w-3.5", short: "h-1.25 w-3.5" },
};

/** 一条链的进度条；label 是链的名称（{@link chainLabel}）。 */
export function ChainBar({
	label,
	nodes,
	variant = "ticks",
}: {
	label: string;
	nodes: readonly { node_id: string; status: string }[];
	variant?: ChainProgressVariant;
}) {
	const text = `${label} ${doneCount(nodes)}/${nodes.length}`;
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
							area.tall ? SHAPE[variant].tall : SHAPE[variant].short,
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
	nodes: readonly { node_id: string; status: string }[];
}

/** 各链一行进度条；给出 max 时最多画这么多条，其余只计数（保证表格行高一致）。 */
export function ChainBars({
	chains,
	variant = "ticks",
	max,
}: {
	chains: readonly ChainProgressData[];
	variant?: ChainProgressVariant;
	max?: number;
}) {
	const shown = chains.filter((c) => c.nodes.length > 0);
	const visible = max === undefined ? shown : shown.slice(0, max);
	const rest = shown.length - visible.length;
	return (
		<span className="flex items-center gap-2">
			<span className="flex flex-col gap-0.75">
				{visible.map((chain) => (
					<ChainBar
						key={chain.id}
						label={chainLabel(chain)}
						nodes={chain.nodes}
						variant={variant}
					/>
				))}
			</span>
			{rest > 0 && <span className="text-2xs text-fg-3">+{rest} 条子流程</span>}
		</span>
	);
}
