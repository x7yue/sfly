import type { RunListChain, RunListItem } from "@sfly/schema";
import { cn } from "cn";
import type { StatusKind } from "#/components/status";

/** 运行记录页的小部件：运行状态、各链进度条（原型 runPill / chainBarsOne）。 */

export const RUN_STATUS: Record<RunListItem["status"], { kind: StatusKind; label: string }> = {
	running: { kind: "running", label: "运行中" },
	success: { kind: "ok", label: "成功" },
	failed: { kind: "failed", label: "失败" },
	cancelled: { kind: "cancelled", label: "已取消" },
};

export const chainLabel = (chain: { subflow: boolean; chain_id: string }) =>
	chain.subflow ? `子流程 ${chain.chain_id}` : "主链";

/** 已完成的节点（成功或跳过）。 */
const isDone = (status: string) => status === "success" || status === "skipped";

export const chainDone = (chain: RunListChain) =>
	chain.nodes.filter((n) => isDone(n.status)).length;

/** 节点状态 → 进度段（原型 .bars b）；排队与待执行为空槽。 */
const SEGMENT: Record<string, string> = {
	success: "bg-ok/70",
	running: "bg-signal",
	dispatched: "bg-signal",
	failed: "bg-danger",
	waiting: "bg-warn/45",
	skipped: "shadow-[inset_0_0_0_1px_var(--border-strong)]",
	cancelled: "border border-dashed border-cancelled",
};

/** 一条链的进度条：每个节点一段，读屏读出「主链 2/3」。 */
export function ChainBar({ chain, compact }: { chain: RunListChain; compact?: boolean }) {
	const label = `${chainLabel(chain)} ${chainDone(chain)}/${chain.nodes.length}`;
	return (
		<span role="img" aria-label={label} title={label} className="inline-flex flex-none gap-0.5">
			{chain.nodes.map((node) => (
				<b
					key={node.node_id}
					className={cn(
						"w-1.5 flex-none rounded-[2px]",
						compact ? "h-1.5" : "h-3",
						SEGMENT[node.status] ?? "bg-track",
					)}
				/>
			))}
		</span>
	);
}

/** 表格里最多画几条链，其余只计数，保证行高一致。 */
const MAX_TABLE_CHAINS = 3;

/** 各链一行的紧凑进度条（表格里用）。 */
export function ChainBars({ chains }: { chains: RunListChain[] }) {
	const shown = chains.filter((c) => c.nodes.length > 0);
	const rest = shown.length - MAX_TABLE_CHAINS;
	return (
		<span className="flex items-center gap-2">
			<span className="flex flex-col gap-0.75">
				{shown.slice(0, MAX_TABLE_CHAINS).map((chain) => (
					<ChainBar key={chain.id} chain={chain} compact />
				))}
			</span>
			{rest > 0 && <span className="text-2xs text-fg-3">+{rest} 条子流程</span>}
		</span>
	);
}
