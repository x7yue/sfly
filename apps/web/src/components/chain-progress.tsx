import { cn } from "cn";
import { chainLabel } from "#/lib/copy";
import { nodeStatusDisplay } from "#/lib/node-status";

/**
 * 各链进度条（原型 chainBars / chainBarsOne）：每个节点一段，读屏读出「主链 2/3」。
 * 控制台、运行记录（卡片与表格）、运行抽屉共用；配色只在这里定义。
 *
 * variant：`ticks` 竖向短段（运行记录、运行抽屉）；`wide` 横向长段（控制台「正在运行」）。
 */
export type ChainProgressVariant = "ticks" | "wide";

/** 已完成的节点数（哪些状态算已完成见 lib/node-status）。 */
export const doneCount = (nodes: readonly { status: string }[]) =>
	nodes.filter((n) => nodeStatusDisplay(n.status)?.done).length;

/** 进度条上一段的样式种类（节点状态对应哪一种见 lib/node-status）；empty 是空槽（排队、待执行）。 */
export type ChainBarSegment =
	| "ok"
	| "running"
	| "failed"
	| "waiting"
	| "skipped"
	| "cancelled"
	| "stopped"
	| "empty";

const SEGMENT: Record<ChainBarSegment, string> = {
	ok: "bg-ok/70",
	running: "bg-signal-soft shadow-[inset_0_0_0_1px_var(--signal-line)]",
	failed: "bg-danger",
	waiting: "bg-warn/45",
	skipped: "shadow-[inset_0_0_0_1px_var(--border-strong)]",
	cancelled: "border border-dashed border-cancelled",
	stopped: "bg-stopped/55",
	empty: "bg-track",
};

const SHAPE: Record<ChainProgressVariant, string> = {
	ticks: "h-3 w-1.5",
	wide: "h-1.5 w-3.5",
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
		<span role="img" aria-label={text} title={text} className="inline-flex flex-none gap-0.5">
			{nodes.map((node) => (
				<b
					key={node.node_id}
					className={cn(
						"flex-none rounded-[2px]",
						SHAPE[variant],
						SEGMENT[nodeStatusDisplay(node.status)?.bar ?? "empty"],
					)}
				/>
			))}
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
